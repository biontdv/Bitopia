// DOM panels that subscribe to the store and re-render on change:
//  - Monitoring panel: lists agents with per-agent Pause / Resume / Start /
//    Stop and a cambuk (whip) button; plus an orchestrator "Stop all work".
//  - Office setup / customize panel: edit room layout, add/remove furniture,
//    and upload a company logo. It calls office.update and uploads via
//    POST /api/logo, and it works both at first setup and after the office
//    already exists.
//
// These panels only build DOM and dispatch commands; all state lives in the
// store and all protocol traffic goes through the Socket.
// A small helper to create an element with props and children.
function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined)
            continue;
        if (k === "class")
            el.className = v;
        else
            el.setAttribute(k, v);
    }
    for (const c of children) {
        el.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
}
const FURNITURE_TYPES = ["desk", "sofa", "billiard", "coffee", "plant", "whiteboard"];
export class MonitoringPanel {
    constructor(root, store, socket) {
        this.root = root;
        this.store = store;
        this.socket = socket;
        store.subscribe(() => this.render());
        this.render();
    }
    render() {
        const s = this.store.get();
        this.root.replaceChildren();
        // Orchestrator / main-agent control row.
        const orch = h("div", { class: "orchestrator" }, [
            h("div", { class: "orch-label" }, [
                h("span", { class: "orch-title" }, ["Orchestrator"]),
                h("span", { class: `conn-dot ${s.connected ? "on" : "off"}` }, []),
                h("span", { class: "conn-text" }, [s.connected ? "connected" : "offline"]),
            ]),
            (() => {
                const btn = h("button", { class: "btn btn-stop-all" }, ["Stop all work"]);
                btn.addEventListener("click", () => this.socket.send("agent.stopAll", "", {}));
                return btn;
            })(),
        ]);
        this.root.append(orch);
        if (s.lastError) {
            this.root.append(h("div", { class: "error-line" }, [s.lastError]));
        }
        const ids = s.order.length ? s.order : Object.keys(s.agents);
        if (ids.length === 0) {
            this.root.append(h("p", { class: "muted" }, ["No agents configured."]));
            return;
        }
        const list = h("div", { class: "agent-list" }, []);
        for (const id of ids) {
            const a = s.agents[id];
            if (!a)
                continue;
            list.append(this.agentCard(id, a.displayName, a.adapter, a.state));
        }
        this.root.append(list);
    }
    agentCard(id, name, adapter, state) {
        const send = (type) => this.socket.send(type, id, {});
        const start = h("button", { class: "btn" }, ["Start"]);
        start.addEventListener("click", () => send("agent.start"));
        const pause = h("button", { class: "btn" }, ["Pause"]);
        pause.addEventListener("click", () => send("agent.pause"));
        const resume = h("button", { class: "btn" }, ["Resume"]);
        resume.addEventListener("click", () => send("agent.resume"));
        const stop = h("button", { class: "btn" }, ["Stop"]);
        stop.addEventListener("click", () => send("agent.stop"));
        const whip = h("button", { class: "btn btn-whip", title: "Cambuk! (just for fun)" }, [
            "Cambuk",
        ]);
        whip.addEventListener("click", () => send("agent.whip"));
        // Enable/disable buttons by state to keep the UI friendly and clear.
        pause.toggleAttribute("disabled", state !== "running");
        resume.toggleAttribute("disabled", state !== "paused");
        stop.toggleAttribute("disabled", !["running", "paused", "starting"].includes(state));
        start.toggleAttribute("disabled", !["idle", "stopped", "crashed"].includes(state));
        return h("div", { class: "agent-card" }, [
            h("div", { class: "agent-head" }, [
                h("span", { class: `state-dot ${state}` }, []),
                h("span", { class: "agent-name" }, [name]),
                h("span", { class: "agent-meta" }, [`${adapter} / ${state}`]),
            ]),
            h("div", { class: "agent-buttons" }, [start, pause, resume, stop, whip]),
        ]);
    }
}
export class OfficePanel {
    constructor(root, store, socket) {
        this.root = root;
        this.store = store;
        this.socket = socket;
        this.draft = null;
        store.subscribe(() => this.onStore());
        this.render();
    }
    // onStore adopts server office state into the editable draft when we do not
    // already have local edits in flight (first load / external updates).
    onStore() {
        const o = this.store.get().office;
        if (o && !this.draft) {
            this.draft = clone(o);
        }
        this.render();
    }
    render() {
        const s = this.store.get();
        this.root.replaceChildren();
        const office = this.draft ?? s.office;
        this.root.append(h("p", { class: "muted small" }, [
            "Customize the office during setup and anytime after it exists. Changes apply with Save.",
        ]));
        if (!office) {
            this.root.append(h("p", { class: "muted" }, ["Waiting for office state..."]));
            return;
        }
        // Office name.
        this.root.append(this.nameRow(office));
        // Rooms.
        this.root.append(h("h3", {}, ["Rooms"]));
        for (const room of office.rooms) {
            this.root.append(this.roomRow(room));
        }
        // Furniture.
        this.root.append(h("h3", {}, ["Furniture"]));
        for (const f of office.furniture) {
            this.root.append(this.furnitureRow(f));
        }
        this.root.append(this.addFurnitureRow());
        // Logo upload.
        this.root.append(h("h3", {}, ["Company logo"]));
        this.root.append(this.logoRow(s));
        // Save / Reset.
        const save = h("button", { class: "btn btn-primary" }, ["Save office"]);
        save.addEventListener("click", () => {
            if (this.draft) {
                this.socket.send("office.update", "", this.draft);
            }
        });
        const reset = h("button", { class: "btn" }, ["Reset"]);
        reset.addEventListener("click", () => {
            this.draft = s.office ? clone(s.office) : null;
            this.render();
        });
        this.root.append(h("div", { class: "office-actions" }, [save, reset]));
    }
    ensureDraft() {
        if (!this.draft) {
            const o = this.store.get().office;
            this.draft = o ? clone(o) : { id: "office-1", name: "HQ", rooms: [], furniture: [] };
        }
        return this.draft;
    }
    nameRow(office) {
        const input = h("input", { class: "txt", type: "text", value: office.name });
        input.addEventListener("input", () => {
            this.ensureDraft().name = input.value;
        });
        return h("label", { class: "field" }, [h("span", {}, ["Name"]), input]);
    }
    roomRow(room) {
        const num = (key) => {
            const inp = h("input", {
                class: "num",
                type: "number",
                value: String(room[key]),
            });
            inp.addEventListener("input", () => {
                const d = this.ensureDraft();
                const target = d.rooms.find((r) => r.id === room.id);
                if (target)
                    target[key] = Math.round(Number(inp.value) || 0);
            });
            return h("label", { class: "field-inline" }, [h("span", {}, [key.toUpperCase()]), inp]);
        };
        const nameInp = h("input", {
            class: "txt",
            type: "text",
            value: room.name,
        });
        nameInp.addEventListener("input", () => {
            const d = this.ensureDraft();
            const target = d.rooms.find((r) => r.id === room.id);
            if (target)
                target.name = nameInp.value;
        });
        return h("div", { class: "row-card" }, [
            h("div", { class: "row-line" }, [h("span", { class: "tag" }, ["room"]), nameInp]),
            h("div", { class: "row-line" }, [num("x"), num("y"), num("w"), num("h")]),
        ]);
    }
    furnitureRow(f) {
        const typeSel = h("select", { class: "sel" }, FURNITURE_TYPES.map((t) => h("option", t === f.type ? { value: t, selected: "selected" } : { value: t }, [t])));
        typeSel.addEventListener("change", () => {
            const target = this.ensureDraft().furniture.find((x) => x.id === f.id);
            if (target)
                target.type = typeSel.value;
        });
        const num = (key) => {
            const inp = h("input", {
                class: "num",
                type: "number",
                value: String(f[key]),
            });
            inp.addEventListener("input", () => {
                const target = this.ensureDraft().furniture.find((x) => x.id === f.id);
                if (target)
                    target[key] = Math.round(Number(inp.value) || 0);
            });
            return h("label", { class: "field-inline" }, [h("span", {}, [key]), inp]);
        };
        const del = h("button", { class: "btn btn-danger" }, ["Remove"]);
        del.addEventListener("click", () => {
            const d = this.ensureDraft();
            d.furniture = d.furniture.filter((x) => x.id !== f.id);
            this.render();
        });
        return h("div", { class: "row-card" }, [
            h("div", { class: "row-line" }, [typeSel, num("x"), num("y"), num("rotation"), del]),
        ]);
    }
    addFurnitureRow() {
        const add = h("button", { class: "btn" }, ["Add furniture"]);
        add.addEventListener("click", () => {
            const d = this.ensureDraft();
            const roomId = d.rooms[0]?.id ?? "room-1";
            d.furniture.push({
                id: `f-${Date.now()}`,
                type: "plant",
                roomId,
                x: 200,
                y: 200,
                rotation: 0,
            });
            this.render();
        });
        return h("div", { class: "office-actions" }, [add]);
    }
    logoRow(s) {
        const file = h("input", { class: "file", type: "file", accept: "image/*" });
        const upload = h("button", { class: "btn" }, ["Upload logo"]);
        const status = h("span", { class: "muted small" }, [
            s.office?.logoRef ? "logo set" : "no logo yet",
        ]);
        upload.addEventListener("click", async () => {
            const f = file.files?.[0];
            if (!f) {
                status.textContent = "choose an image first";
                return;
            }
            const form = new FormData();
            form.append("logo", f);
            status.textContent = "uploading...";
            try {
                const res = await fetch("/api/logo", { method: "POST", body: form });
                status.textContent = res.ok ? "uploaded" : `failed (${res.status})`;
                // The daemon broadcasts office.state after a successful upload, so the
                // scene re-renders the logo automatically.
            }
            catch {
                status.textContent = "upload error";
            }
        });
        return h("div", { class: "row-line" }, [file, upload, status]);
    }
}
function clone(v) {
    return JSON.parse(JSON.stringify(v));
}
