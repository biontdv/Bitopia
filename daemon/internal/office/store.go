package office

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Store owns the current office and persists it atomically to office.json under
// the data directory.
type Store struct {
	mu      sync.RWMutex
	dataDir string
	office  Office
}

// NewStore loads an existing office from dataDir/office.json, or creates and
// persists a default office on first run.
func NewStore(dataDir string) (*Store, error) {
	if dataDir == "" {
		dataDir = "./data"
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{dataDir: dataDir}

	path := s.officePath()
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		s.office = DefaultOffice()
		if err := s.persist(s.office); err != nil {
			return nil, err
		}
	case err != nil:
		return nil, err
	default:
		var o Office
		if err := json.Unmarshal(data, &o); err != nil {
			return nil, err
		}
		s.office = o
	}
	return s, nil
}

func (s *Store) officePath() string { return filepath.Join(s.dataDir, "office.json") }

// DataDir returns the configured data directory.
func (s *Store) DataDir() string { return s.dataDir }

// Get returns a copy of the current office.
func (s *Store) Get() Office {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.office
}

// Update merges a (possibly partial) office update, persists it atomically, and
// returns the stored value. Zero-value name/rooms/furniture in the incoming
// patch are treated as "leave unchanged" except where explicitly provided.
func (s *Store) Update(patch Office) (Office, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cur := s.office
	if patch.ID != "" {
		cur.ID = patch.ID
	}
	if patch.Name != "" {
		cur.Name = patch.Name
	}
	// Note: logoRef is intentionally NOT taken from an office.update patch. The
	// logo reference is owned by the upload endpoint (SetLogoRef), which is the
	// only writer that also stores the matching image bytes GET serves. Honoring
	// an arbitrary client-set logoRef here would let the reference and the served
	// bytes disagree, so we preserve the server-owned value instead.
	if patch.Rooms != nil {
		cur.Rooms = patch.Rooms
	}
	if patch.Furniture != nil {
		cur.Furniture = patch.Furniture
	}

	if err := s.persist(cur); err != nil {
		return Office{}, err
	}
	s.office = cur
	return cur, nil
}

// SetLogoRef updates only the logo reference and persists.
func (s *Store) SetLogoRef(ref string) (Office, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.office
	cur.LogoRef = ref
	if err := s.persist(cur); err != nil {
		return Office{}, err
	}
	s.office = cur
	return cur, nil
}

// persist writes the office to a temp file and renames it into place for an
// atomic update. Callers must hold the appropriate lock.
func (s *Store) persist(o Office) error {
	data, err := json.MarshalIndent(o, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dataDir, "office-*.json.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, s.officePath())
}
