// Command officed is the Agentic Virtual Office host daemon. It serves the
// browser UI over HTTP, exposes a WebSocket endpoint for live messaging,
// supervises agent CLIs (or the built-in MOCK agent), and owns the office
// customization store. It uses only the Go standard library.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/agentic-office/daemon/internal/agent"
	"github.com/agentic-office/daemon/internal/config"
	"github.com/agentic-office/daemon/internal/office"
	"github.com/agentic-office/daemon/internal/ws"
	"github.com/agentic-office/daemon/web"
)

func main() {
	addr := flag.String("addr", "", "listen address (overrides config; default :8080)")
	cfgPath := flag.String("config", "", "path to a JSON config file (optional)")
	dataDir := flag.String("data", "", "data directory (overrides config; default ./data)")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("officed: %v", err)
	}
	cfg.ApplyOverrides(*addr, *dataDir)

	store, err := office.NewStore(cfg.DataDir)
	if err != nil {
		log.Fatalf("officed: office store: %v", err)
	}

	srv := newServer(cfg, store)

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: srv.routes(),
	}

	// Graceful shutdown on SIGINT/SIGTERM: stop agents, close the server.
	idleClosed := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Printf("officed: shutting down")
		srv.manager.Shutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
		close(idleClosed)
	}()

	log.Printf("officed: listening on %s (data=%s, agents=%d)", cfg.Addr, cfg.DataDir, len(cfg.Agents))
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("officed: %v", err)
	}
	<-idleClosed
}

// server bundles the daemon's long-lived components.
type server struct {
	cfg     config.Config
	hub     *ws.Hub
	manager *agent.Manager
	store   *office.Store
}

func newServer(cfg config.Config, store *office.Store) *server {
	s := &server{cfg: cfg, store: store}
	s.hub = ws.NewHub(s.handleCommand)
	s.hub.SetOnConnect(s.seedClient)
	s.manager = agent.NewManager(s.hub)
	for _, a := range cfg.Agents {
		s.manager.Add(agent.AgentConfig{
			ID:          a.ID,
			DisplayName: a.DisplayName,
			Adapter:     a.Adapter,
			Argv:        a.Argv,
			Env:         a.Env,
			WorkDir:     a.WorkDir,
		})
	}
	return s
}

// routes builds the HTTP mux.
func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/logo", s.handleLogo)
	mux.Handle("/", s.staticHandler())
	return mux
}

func (s *server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ok\n")
}

// handleWS upgrades the connection to a WebSocket. The hub's on-connect seed
// (see seedClient) sends the initial roster and office state so a fresh client
// renders immediately.
func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	s.hub.Handler()(w, r)
}

// seedClient sends the current agent roster and office state to a freshly
// connected client so the UI renders immediately without extra round-trips.
func (s *server) seedClient(conn *ws.Conn) {
	conn.Send(ws.MustEnvelope("agent.list", "", s.manager.List()))
	conn.Send(ws.MustEnvelope("office.state", "", s.store.Get()))
}

// handleCommand routes a decoded client command to the manager or office store
// and broadcasts the resulting events.
func (s *server) handleCommand(conn *ws.Conn, env ws.Envelope) {
	switch env.Type {
	case "agent.start":
		var p struct {
			Adapter string `json:"adapter"`
		}
		_ = json.Unmarshal(env.Payload, &p)
		if err := s.manager.Start(env.AgentID, p.Adapter); err != nil {
			conn.Send(mapError(env.AgentID, err))
			return
		}
		s.manager.BroadcastList()

	case "agent.pause":
		if err := s.manager.Pause(env.AgentID); err != nil {
			conn.Send(mapError(env.AgentID, err))
		}

	case "agent.resume":
		if err := s.manager.Resume(env.AgentID); err != nil {
			conn.Send(mapError(env.AgentID, err))
		}

	case "agent.stop":
		var p struct {
			GraceMs int `json:"graceMs"`
		}
		_ = json.Unmarshal(env.Payload, &p)
		grace := time.Duration(p.GraceMs) * time.Millisecond
		if err := s.manager.Stop(env.AgentID, grace); err != nil {
			conn.Send(mapError(env.AgentID, err))
		}

	case "agent.stopAll":
		s.manager.StopAll()

	case "agent.whip":
		if err := s.manager.Whip(env.AgentID); err != nil {
			conn.Send(mapError(env.AgentID, err))
		}

	case "office.get":
		conn.Send(ws.MustEnvelope("office.state", "", s.store.Get()))

	case "office.update":
		var patch office.Office
		if err := json.Unmarshal(env.Payload, &patch); err != nil {
			conn.Send(ws.ErrorEnvelope("", ws.CodeBadRequest, "invalid office payload"))
			return
		}
		updated, err := s.store.Update(patch)
		if err != nil {
			conn.Send(ws.ErrorEnvelope("", ws.CodeInternal, err.Error()))
			return
		}
		s.hub.Broadcast(ws.MustEnvelope("office.state", "", updated))

	default:
		conn.Send(ws.ErrorEnvelope(env.AgentID, ws.CodeUnknownType, "unknown message type: "+env.Type))
	}
}

// mapError converts a manager sentinel error into an error envelope with the
// matching WebSocket error code.
func mapError(agentID string, err error) ws.Envelope {
	switch {
	case errors.Is(err, agent.ErrUnknownAgent):
		return ws.ErrorEnvelope(agentID, ws.CodeUnknownAgent, err.Error())
	case errors.Is(err, agent.ErrInvalidTransition):
		return ws.ErrorEnvelope(agentID, ws.CodeInvalidTransition, err.Error())
	default:
		return ws.ErrorEnvelope(agentID, ws.CodeInternal, err.Error())
	}
}

// logo upload size cap (5 MiB).
const maxLogoBytes = 5 << 20

// handleLogo serves GET (the stored logo) and POST (multipart upload).
func (s *server) handleLogo(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		path := s.store.DataDir() + "/logo"
		f, err := os.Open(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		http.ServeContent(w, r, "logo", time.Now(), f)

	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, maxLogoBytes+1024)
		if err := r.ParseMultipartForm(maxLogoBytes + 1024); err != nil {
			s.hub.Broadcast(ws.ErrorEnvelope("", ws.CodeLogoTooLarge, "logo too large"))
			http.Error(w, "logo too large", http.StatusRequestEntityTooLarge)
			return
		}
		file, header, err := r.FormFile("logo")
		if err != nil {
			http.Error(w, "missing logo field", http.StatusBadRequest)
			return
		}
		defer file.Close()
		if header.Size > maxLogoBytes {
			http.Error(w, "logo too large", http.StatusRequestEntityTooLarge)
			return
		}

		data, err := io.ReadAll(io.LimitReader(file, maxLogoBytes))
		if err != nil {
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}
		if ct := http.DetectContentType(data); len(ct) < 6 || ct[:6] != "image/" {
			http.Error(w, "not an image", http.StatusUnsupportedMediaType)
			return
		}
		if err := os.WriteFile(s.store.DataDir()+"/logo", data, 0o644); err != nil {
			http.Error(w, "write error", http.StatusInternalServerError)
			return
		}
		updated, err := s.store.SetLogoRef("/api/logo?v=" + timeVersion())
		if err != nil {
			http.Error(w, "store error", http.StatusInternalServerError)
			return
		}
		s.hub.Broadcast(ws.MustEnvelope("office.state", "", updated))
		w.WriteHeader(http.StatusOK)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func timeVersion() string {
	return time.Now().Format("20060102150405")
}

// staticHandler serves the embedded UI with an index.html fallback for
// client-side routes. If the embed is unavailable it serves a tiny inline page.
func (s *server) staticHandler() http.Handler {
	fsys, err := web.FS()
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, "<!doctype html><title>officed</title><h1>daemon running</h1>")
		})
	}
	fileServer := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Serve the file if it exists; otherwise fall back to index.html.
		if f, ferr := fsys.Open(trimLeadingSlash(r.URL.Path)); ferr == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		fileServer.ServeHTTP(w, r2)
	})
}

func trimLeadingSlash(p string) string {
	if p == "/" || p == "" {
		return "index.html"
	}
	if p[0] == '/' {
		return p[1:]
	}
	return p
}
