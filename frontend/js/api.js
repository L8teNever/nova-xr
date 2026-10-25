async function json(response) {
  if (response.ok) return response.status === 204 ? null : response.json();
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {
    /* keep status text */
  }
  const error = new Error(detail);
  error.status = response.status;
  throw error;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

export const api = {
  config: () => fetch("/api/config").then(json),
  version: () => fetch("/api/version").then(json),
  listModels: () => fetch("/api/models").then(json).then((body) => body.models),

  rename: (id, name, token) =>
    fetch(`/api/models/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then(json),

  remove: (id, token) =>
    fetch(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(token) }).then(json),

  /** XHR instead of fetch: upload progress events work in every browser including the Quest browser. */
  upload(file, name, token, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const params = new URLSearchParams({ filename: file.name, name: name || "" });
      xhr.open("POST", `/api/models?${params}`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (event) => event.lengthComputable && onProgress?.(event.loaded / event.total);
      xhr.onerror = () => reject(new Error("Netzwerkfehler beim Hochladen."));
      xhr.onload = () => {
        let body = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON error page */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else {
          const error = new Error(body?.detail || `${xhr.status} ${xhr.statusText}`);
          error.status = xhr.status;
          reject(error);
        }
      };
      xhr.send(file);
    });
  },
};
