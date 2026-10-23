package agent

// State is an agent lifecycle state.
type State string

// Lifecycle states (see DESIGN.md section 3).
const (
	StateIdle     State = "idle"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StatePaused   State = "paused"
	StateStopping State = "stopping"
	StateStopped  State = "stopped"
	StateCrashed  State = "crashed"
)

// StatePayload is the body of an agent.state envelope.
type StatePayload struct {
	State       State  `json:"state"`
	Adapter     string `json:"adapter"`
	DisplayName string `json:"displayName"`
	PID         int    `json:"pid"`
	Restarts    int    `json:"restarts"`
	Whipped     bool   `json:"whipped"`
}

// OutputPayload is the body of an agent.output envelope.
type OutputPayload struct {
	Stream string `json:"stream"`
	Data   string `json:"data"`
}

// ListEntry describes an agent in an agent.list envelope.
type ListEntry struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Adapter     string `json:"adapter"`
	State       State  `json:"state"`
}

// ListPayload is the body of an agent.list envelope.
type ListPayload struct {
	Agents []ListEntry `json:"agents"`
}

// canTransition reports whether a direct move from -> to is allowed by the FSM
// in DESIGN.md section 3.2. It covers only transitions driven by client
// commands and internal events; it is used to reject illegal commands early.
func canTransition(from, to State) bool {
	switch from {
	case StateIdle:
		return to == StateStarting
	case StateStopped:
		return to == StateStarting
	case StateCrashed:
		return to == StateStarting
	case StateStarting:
		return to == StateRunning || to == StateCrashed || to == StateStopping
	case StateRunning:
		// running can also go directly to stopped when the process terminates on
		// its own (a clean self-exit), without an explicit stop request.
		return to == StatePaused || to == StateStopping || to == StateStopped || to == StateCrashed
	case StatePaused:
		return to == StateRunning || to == StateStopping || to == StateStopped || to == StateCrashed
	case StateStopping:
		return to == StateStopped || to == StateCrashed
	default:
		return false
	}
}
