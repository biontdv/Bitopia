// Office setup / customize view. It edits the room layout, picks furniture, and
// uploads the company logo. It is reachable both during first setup (when the
// daemon has only a default office) and anytime after the office exists; there
// is no separate "setup only" path (DESIGN.md section 5.2). Save dispatches
// office.update over the WebSocket; the logo is uploaded over HTTP to
// POST /api/logo and the daemon broadcasts office.state so the scene re-renders.

import { useEffect, useState } from "react";
import { useWs } from "../ws/WsContext";
import { useOffice, selectOffice } from "../store/hooks";
import type { Furniture, Office, Room } from "../ws/protocol";

const FURNITURE_TYPES = ["desk", "sofa", "billiard", "coffee", "plant", "whiteboard"];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function OfficeSetup() {
  const ws = useWs();
  const office = useOffice(selectOffice);
  const [draft, setDraft] = useState<Office | null>(null);
  // dirty tracks whether the user has made local edits the server has not seen.
  const [dirty, setDirty] = useState(false);
  const [logoStatus, setLogoStatus] = useState<string>("");

  // Reconcile with the server office. While the user has NOT touched the draft
  // locally (not dirty), we re-adopt any server change so external updates
  // (a logo upload broadcast, another client's office.update) immediately refresh
  // the open editor. Once the draft is dirty we stop clobbering the user's edits
  // and instead surface a "server changed" reload affordance below.
  useEffect(() => {
    if (!office) return;
    if (!dirty) setDraft(clone(office));
  }, [office, dirty]);

  // Detect a server change the user has not yet reconciled while editing.
  const serverChangedWhileDirty =
    dirty && draft != null && office != null && JSON.stringify(office) !== JSON.stringify(draft);

  const current = draft ?? office;
  if (!current) {
    return (
      <section className="panel">
        <p className="muted">Waiting for office state...</p>
      </section>
    );
  }

  // Mutate a copy of the draft and store it so inputs stay controlled. Any edit
  // marks the draft dirty so the server-reconcile effect stops overwriting it.
  const edit = (fn: (d: Office) => void) => {
    const base = draft ?? clone(current);
    const next = clone(base);
    fn(next);
    setDraft(next);
    setDirty(true);
  };

  // editDraft replaces the whole draft (used by furniture add/remove) and marks
  // it dirty.
  const editDraft = (next: Office) => {
    setDraft(next);
    setDirty(true);
  };

  const save = () => {
    if (draft) {
      ws.updateOffice(draft);
      // The broadcast echo will re-sync; treat the local draft as clean again.
      setDirty(false);
    }
  };
  const reset = () => {
    setDraft(office ? clone(office) : null);
    setDirty(false);
  };
  // reloadFromServer discards local edits and adopts the latest server office.
  const reloadFromServer = () => {
    setDraft(office ? clone(office) : null);
    setDirty(false);
  };

  const uploadLogo = async (file: File) => {
    const form = new FormData();
    form.append("logo", file);
    setLogoStatus("uploading...");
    try {
      const res = await fetch("/api/logo", { method: "POST", body: form });
      setLogoStatus(res.ok ? "uploaded" : `failed (${res.status})`);
    } catch {
      setLogoStatus("upload error");
    }
  };

  return (
    <section className="panel office-setup">
      <p className="muted small">
        Customize the office during setup and anytime after it exists. Changes apply with Save.
      </p>

      {serverChangedWhileDirty && (
        <div className="server-changed">
          <span className="muted small">
            The office changed on the server while you were editing.
          </span>
          <button className="btn" onClick={reloadFromServer}>
            Reload from server
          </button>
        </div>
      )}

      <label className="field">
        <span>Office name</span>
        <input
          className="txt"
          type="text"
          value={current.name}
          onChange={(e) => edit((d) => (d.name = e.target.value))}
        />
      </label>

      <h3>Rooms</h3>
      {current.rooms.map((room) => (
        <RoomRow key={room.id} room={room} edit={edit} />
      ))}

      <h3>Furniture</h3>
      {current.furniture.map((f) => (
        <FurnitureRow key={f.id} f={f} edit={edit} editDraft={editDraft} draft={draft} current={current} />
      ))}
      <div className="office-actions">
        <button
          className="btn"
          onClick={() =>
            edit((d) => {
              const roomId = d.rooms[0]?.id ?? "room-1";
              d.furniture.push({
                id: `f-${Date.now()}`,
                type: "plant",
                roomId,
                x: 200,
                y: 200,
                rotation: 0,
              });
            })
          }
        >
          Add furniture
        </button>
      </div>

      <h3>Company logo</h3>
      <div className="row-line">
        <input
          className="file"
          type="file"
          accept="image/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadLogo(f);
          }}
        />
        <span className="muted small">
          {logoStatus || (current.logoRef ? "logo set" : "no logo yet")}
        </span>
      </div>

      <div className="office-actions">
        <button className="btn btn-primary" onClick={save}>
          Save office
        </button>
        <button className="btn" onClick={reset}>
          Reset
        </button>
      </div>
    </section>
  );
}

function RoomRow({ room, edit }: { room: Room; edit: (fn: (d: Office) => void) => void }) {
  const num = (key: "x" | "y" | "w" | "h") => (
    <label className="field-inline" key={key}>
      <span>{key.toUpperCase()}</span>
      <input
        className="num"
        type="number"
        value={room[key]}
        onChange={(e) =>
          edit((d) => {
            const t = d.rooms.find((r) => r.id === room.id);
            if (t) t[key] = Math.round(Number(e.target.value) || 0);
          })
        }
      />
    </label>
  );
  return (
    <div className="row-card">
      <div className="row-line">
        <span className="tag">room</span>
        <input
          className="txt"
          type="text"
          value={room.name}
          onChange={(e) =>
            edit((d) => {
              const t = d.rooms.find((r) => r.id === room.id);
              if (t) t.name = e.target.value;
            })
          }
        />
      </div>
      <div className="row-line">{(["x", "y", "w", "h"] as const).map((k) => num(k))}</div>
    </div>
  );
}

function FurnitureRow({
  f,
  edit,
  editDraft,
  draft,
  current,
}: {
  f: Furniture;
  edit: (fn: (d: Office) => void) => void;
  editDraft: (o: Office) => void;
  draft: Office | null;
  current: Office;
}) {
  const num = (key: "x" | "y" | "rotation") => (
    <label className="field-inline" key={key}>
      <span>{key}</span>
      <input
        className="num"
        type="number"
        value={f[key]}
        onChange={(e) =>
          edit((d) => {
            const t = d.furniture.find((x) => x.id === f.id);
            if (t) t[key] = Math.round(Number(e.target.value) || 0);
          })
        }
      />
    </label>
  );

  const remove = () => {
    const base = clone(draft ?? current);
    base.furniture = base.furniture.filter((x) => x.id !== f.id);
    editDraft(base);
  };

  return (
    <div className="row-card">
      <div className="row-line">
        <select
          className="sel"
          value={f.type}
          onChange={(e) =>
            edit((d) => {
              const t = d.furniture.find((x) => x.id === f.id);
              if (t) t.type = e.target.value;
            })
          }
        >
          {FURNITURE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {(["x", "y", "rotation"] as const).map((k) => num(k))}
        <button className="btn btn-danger" onClick={remove}>
          Remove
        </button>
      </div>
    </div>
  );
}
