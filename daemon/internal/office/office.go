// Package office implements the office customization data model and its on-disk
// persistence. The office is a JSON document created in a setup flow and
// editable at any time afterward. It uses only the Go standard library.
package office

// Office is the customization document (see DESIGN.md section 5).
type Office struct {
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	LogoRef   string      `json:"logoRef,omitempty"`
	Rooms     []Room      `json:"rooms"`
	Furniture []Furniture `json:"furniture"`
}

// Room is a rectangular area of the office scene.
type Room struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

// Furniture is a placed item. Type values like "sofa"/"couch"/"billiard"/
// "coffee" also act as idle-behavior anchors for the ambient office-life UI
// feature (a pure UI concern; the daemon only serves the data).
type Furniture struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	RoomID   string `json:"roomId"`
	X        int    `json:"x"`
	Y        int    `json:"y"`
	Rotation int    `json:"rotation"`
}

// DefaultOffice returns a sensible starter office: one room and a few furniture
// items including idle-behavior anchors, with no logo.
func DefaultOffice() Office {
	return Office{
		ID:   "office-1",
		Name: "HQ",
		Rooms: []Room{
			{ID: "room-1", Name: "Engineering", X: 0, Y: 0, W: 800, H: 480},
		},
		Furniture: []Furniture{
			{ID: "f-desk-1", Type: "desk", RoomID: "room-1", X: 80, Y: 80, Rotation: 0},
			{ID: "f-sofa-1", Type: "sofa", RoomID: "room-1", X: 420, Y: 320, Rotation: 0},
			{ID: "f-billiard-1", Type: "billiard", RoomID: "room-1", X: 560, Y: 120, Rotation: 0},
			{ID: "f-coffee-1", Type: "coffee", RoomID: "room-1", X: 120, Y: 360, Rotation: 0},
		},
	}
}
