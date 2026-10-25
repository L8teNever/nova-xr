import { api } from "./api.js";

const TOKEN_KEY = "nova.uploadToken";
const ALLOWED = [".glb", ".gltf", ".vrm"];

function formatSize(bytes) {
  if (!bytes) return "";
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) node.append(child);
  return node;
}

/** HUD section: model list, switching, upload, rename, delete. */
export class ModelsUI {
  constructor({ onSelect, onStatus }) {
    this.onSelect = onSelect;
    this.onStatus = onStatus;
    this.models = [];
    this.activeId = null;
    this.config = { upload_enabled: false, max_upload_mb: 100 };

    this.select = document.getElementById("model-select");
    this.list = document.getElementById("model-list");
    this.form = document.getElementById("upload-form");
    this.fileInput = document.getElementById("upload-file");
    this.nameInput = document.getElementById("upload-name");
    this.tokenInput = document.getElementById("upload-token");
    this.remember = document.getElementById("upload-remember");
    this.progress = document.getElementById("upload-progress");
    this.hint = document.getElementById("upload-hint");
    this.submit = document.getElementById("upload-submit");

    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
      this.tokenInput.value = saved;
      this.remember.checked = true;
    }
    this.select.addEventListener("change", () => this.choose(this.select.value));
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.upload();
    });
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files[0];
      if (file && !this.nameInput.value) this.nameInput.value = file.name.replace(/\.[^.]+$/, "");
    });
  }

  async init() {
    try {
      this.config = await api.config();
    } catch {
      /* offline backend: keep defaults */
    }
    this.hint.textContent = this.config.upload_enabled
      ? `GLB, glTF (eingebettet) oder VRM, max. ${this.config.max_upload_mb} MB. Token aus der .env (UPLOAD_TOKEN).`
      : "Upload ist auf diesem Server deaktiviert (UPLOAD_TOKEN ist nicht gesetzt).";
    this.form.classList.toggle("disabled", !this.config.upload_enabled);
    this.submit.disabled = !this.config.upload_enabled;
    await this.refresh();
  }

  async refresh() {
    try {
      this.models = await api.listModels();
    } catch (error) {
      this.onStatus(`Modellliste nicht ladbar: ${error.message}`);
      this.models = [{ id: "default", name: "Standard-Figur", url: "/api/models/default/file", builtin: true, format: "glb" }];
    }
    this.render();
    return this.models;
  }

  get(id) {
    return this.models.find((m) => m.id === id) || null;
  }

  next(direction = 1) {
    if (!this.models.length) return null;
    const index = this.models.findIndex((m) => m.id === this.activeId);
    return this.models[(index + direction + this.models.length) % this.models.length];
  }

  setActive(id) {
    this.activeId = id;
    this.render();
  }

  choose(id) {
    const model = this.get(id);
    if (model) this.onSelect(model);
  }

  render() {
    this.select.replaceChildren(
      ...this.models.map((m) => el("option", { value: m.id, textContent: m.name, selected: m.id === this.activeId })),
    );
    this.list.replaceChildren(
      ...this.models.map((m) => {
        const info = m.info || {};
        const tags = [m.format?.toUpperCase(), formatSize(m.size)];
        if (m.builtin) tags.push("Standard");
        else if (info.humanoid === false) tags.push("kein humanoides Skelett – nur Anzeige");
        else if (info.vrm_version) tags.push(`VRM ${info.vrm_version}`);
        const actions = [
          el("button", { type: "button", textContent: m.id === this.activeId ? "Aktiv" : "Verwenden", disabled: m.id === this.activeId, onclick: () => this.choose(m.id) }),
        ];
        if (!m.builtin) {
          actions.push(
            el("button", { type: "button", textContent: "Umbenennen", onclick: () => this.rename(m) }),
            el("button", { type: "button", className: "danger", textContent: "Löschen", onclick: () => this.remove(m) }),
          );
        }
        return el("li", { className: m.id === this.activeId ? "active" : "" }, [
          el("div", { className: "model-name", textContent: m.name }),
          el("div", { className: "model-tags", textContent: tags.filter(Boolean).join(" · ") }),
          el("div", { className: "model-actions" }, actions),
        ]);
      }),
    );
  }

  token() {
    let token = this.tokenInput.value.trim();
    if (!token) {
      token = (window.prompt("Upload-Token (UPLOAD_TOKEN aus der .env):") || "").trim();
      this.tokenInput.value = token;
    }
    if (this.remember.checked && token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    return token;
  }

  async upload() {
    const file = this.fileInput.files[0];
    if (!file) return this.onStatus("Bitte eine Datei wählen.");
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED.includes(ext)) return this.onStatus("Nur .glb, .gltf oder .vrm erlaubt.");
    if (file.size > this.config.max_upload_mb * 1024 * 1024) return this.onStatus(`Datei ist größer als ${this.config.max_upload_mb} MB.`);
    const token = this.token();
    if (!token) return this.onStatus("Ohne Token kein Upload.");

    this.submit.disabled = true;
    this.progress.hidden = false;
    this.progress.value = 0;
    try {
      const meta = await api.upload(file, this.nameInput.value.trim(), token, (p) => (this.progress.value = p));
      this.onStatus(`„${meta.name}“ hochgeladen.`);
      const remember = this.remember.checked;
      this.form.reset();
      this.tokenInput.value = token;
      this.remember.checked = remember;
      await this.refresh();
      this.choose(meta.id);
    } catch (error) {
      if (error.status === 401) localStorage.removeItem(TOKEN_KEY);
      this.onStatus(`Upload fehlgeschlagen: ${error.message}`);
    } finally {
      this.submit.disabled = !this.config.upload_enabled;
      this.progress.hidden = true;
    }
  }

  async rename(model) {
    const name = window.prompt("Neuer Name:", model.name);
    if (!name || name.trim() === model.name) return;
    const token = this.token();
    if (!token) return;
    try {
      await api.rename(model.id, name.trim(), token);
      await this.refresh();
      this.onStatus(`Umbenannt in „${name.trim()}“.`);
    } catch (error) {
      this.onStatus(`Umbenennen fehlgeschlagen: ${error.message}`);
    }
  }

  async remove(model) {
    if (!window.confirm(`„${model.name}“ wirklich löschen?`)) return;
    const token = this.token();
    if (!token) return;
    try {
      await api.remove(model.id, token);
      await this.refresh();
      this.onStatus(`„${model.name}“ gelöscht.`);
      if (model.id === this.activeId) this.choose("default");
    } catch (error) {
      this.onStatus(`Löschen fehlgeschlagen: ${error.message}`);
    }
  }
}
