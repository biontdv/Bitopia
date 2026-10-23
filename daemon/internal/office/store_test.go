package office

import (
	"os"
	"path/filepath"
	"testing"
)

// TestNewStoreCreatesDefault asserts first run creates and persists a default
// office.
func TestNewStoreCreatesDefault(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	o := s.Get()
	if o.ID == "" || len(o.Rooms) == 0 {
		t.Fatalf("default office incomplete: %+v", o)
	}
	if _, err := os.Stat(filepath.Join(dir, "office.json")); err != nil {
		t.Fatalf("office.json not persisted: %v", err)
	}
}

// TestUpdatePersistsAndReloads asserts an update is persisted and survives a
// reload from disk, and that a partial patch leaves unspecified fields intact.
func TestUpdatePersistsAndReloads(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	origRooms := len(s.Get().Rooms)

	// Patch only the name; rooms/furniture should be unchanged.
	updated, err := s.Update(Office{Name: "Second Floor"})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Name != "Second Floor" {
		t.Fatalf("name = %q, want Second Floor", updated.Name)
	}
	if len(updated.Rooms) != origRooms {
		t.Fatalf("partial patch changed rooms: got %d want %d", len(updated.Rooms), origRooms)
	}

	// Reload from disk.
	s2, err := NewStore(dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if s2.Get().Name != "Second Floor" {
		t.Fatalf("reloaded name = %q, want Second Floor", s2.Get().Name)
	}

	// Replace rooms and furniture.
	updated, err = s2.Update(Office{
		Rooms:     []Room{{ID: "r9", Name: "Lounge", X: 0, Y: 0, W: 100, H: 100}},
		Furniture: []Furniture{{ID: "f9", Type: "sofa", RoomID: "r9", X: 10, Y: 10}},
	})
	if err != nil {
		t.Fatalf("Update rooms: %v", err)
	}
	if len(updated.Rooms) != 1 || updated.Rooms[0].ID != "r9" {
		t.Fatalf("rooms not replaced: %+v", updated.Rooms)
	}
	if len(updated.Furniture) != 1 || updated.Furniture[0].Type != "sofa" {
		t.Fatalf("furniture not replaced: %+v", updated.Furniture)
	}
}

// TestUpdateIgnoresClientLogoRef asserts that an office.update patch cannot set
// logoRef: the reference is owned by the upload endpoint (SetLogoRef) so it
// cannot disagree with the served image bytes.
func TestUpdateIgnoresClientLogoRef(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if _, err := s.SetLogoRef("/api/logo?v=7"); err != nil {
		t.Fatalf("SetLogoRef: %v", err)
	}
	// A client tries to override logoRef via office.update.
	updated, err := s.Update(Office{Name: "Renamed", LogoRef: "https://evil.example/x.png"})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Name != "Renamed" {
		t.Fatalf("name not updated: %q", updated.Name)
	}
	if updated.LogoRef != "/api/logo?v=7" {
		t.Fatalf("logoRef changed by client patch: %q", updated.LogoRef)
	}
}

// TestSetLogoRef asserts the logo reference is stored and persisted.
func TestSetLogoRef(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if _, err := s.SetLogoRef("/api/logo?v=42"); err != nil {
		t.Fatalf("SetLogoRef: %v", err)
	}
	if s.Get().LogoRef != "/api/logo?v=42" {
		t.Fatalf("logoRef = %q", s.Get().LogoRef)
	}
}
