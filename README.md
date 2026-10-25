# Nova

WebXR-Passthrough-App für den **Meta Quest Browser**: eine realistisch gekleidete, erwachsene Figur im echten Raum platzieren und per Ragdoll anstoßen. Backend: **FastAPI + uvicorn**. Frontend: **three.js + cannon-es**.

WebXR braucht HTTPS (oder localhost). Die öffentliche Basis-URL gehört nur in die lokale `.env` als `PUBLIC_URL`, nicht ins Repository. Platzhalter: `https://example.com`.

## Funktionen

- `immersive-ar` mit Passthrough (echte Umgebung bleibt sichtbar).
- Optionale WebXR-Features: `plane-detection`, `mesh-detection`, `hit-test`, `anchors`, `hand-tracking`.
- Raum-Scan (Boden/Wände/Meshes) als Kollisionsflächen. Fehlen die Features: Fallback-Bodenebene.
- Modus **Platzieren**: Raycast + Hit-Test, Drehen, XR-Anchor.
- Modus **Interaktion**: Ganzkörper-Ragdoll, Kollision mit Händen/Controllern und Raumflächen. Zurück in Platzieren stellt die Figur wieder hin (Idle).
- Sekundärbewegung für Haar/Kleidung nur, wenn Vertices sauber isolierbar sind — siehe Abschnitt „Modell und Grenzen“.

## Modell und Lizenz

Figur: Grab3D *Casual Woman*, rigged GLB (CC0 1.0, keine Attribution nötig).

- Quelle (öffentliches Asset): `https://grab3d.com/models/characters/woman/`
- Rigged-Download: `https://grab3d.com/dl/woman-rigged/woman-rigged.glb`
- Lizenzhinweis: `frontend/assets/models/LICENSE.txt` (CC0)

Die Datei enthält ein Mesh (`char1`), Clips `walk`/`run` (kein Idle) und Körper-/Finger-/Kopf-Joints, aber **keine Haar- oder Kleidungs-Bones**.

Idle im Platzier-Modus ist daher **prozedural** (Atmung und leichtes Gewichtsverlagern auf dem Bind-Pose-Skelett), nicht ein mitgelieferter Clip.

Haar-/Blazer-Physik: ohne eigene Bones und ohne zuverlässig getrennte Material-/UV-Inseln ist eine saubere Vertex-Isolation **nicht** gegeben. Es gibt **keine** vorgetäuschten Spring-Bones auf Haar/Blazer. Ganzkörper-Ragdoll bei Hand- oder Controller-Berührung bleibt aktiv.

## Lokal entwickeln

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

- Health: `GET /health`
- Version: `GET /api/version`
- Modell: `GET/POST/DELETE /api/model` — eigenes geriggtes GLB nur unter `NOVA_DATA_DIR` (Standard `./data`, gitignored)
- UI: `http://127.0.0.1:8080/`

Auf der Seite kannst du eine `.glb` hochladen. Der Server prüft automatisch Skelett/Skin und Animationsclips. Ohne Rig wird abgelehnt. Die Datei liegt **nur auf diesem Server** im Datenordner, nicht im Git-Repo. „Standardmodell“ löscht den Upload wieder.

Tests:

```bash
pytest -q
node frontend/js/smoke.node.mjs
```

## Bedienung

### Meta Quest Browser

1. Quest-Raum einrichten (Guardian / Room Setup), damit Plane-/Mesh-Detection Daten hat.
2. Im Quest-Browser die HTTPS-URL aus `PUBLIC_URL` öffnen (nur lokale `.env`, nicht dieses Repo).
3. **AR starten** tippen und die Session erlauben.
4. **Platzieren**: mit Controller-Ray oder Hand-Ray auf den Boden zielen, Trigger bzw. Pinch setzt die Figur. Stick / Squeeze dreht sie.
5. **Interaktion**: Button *Modus* oder A/X am Controller. Figur wird zum Ragdoll und reagiert auf Schubsen.
6. Zurück auf *Platzieren*: Idle-Pose, Figur steht wieder.

Ohne Hand-Tracking reichen die Controller. Ohne Plane Detection erscheint ein halbtransparenter Fallback-Boden.

### Desktop-Fallback / WebXR-Emulator

Im normalen Desktop-Browser startet keine echte Passthrough-Session. Die Figur steht auf einer Ebene:

| Taste | Aktion |
| --- | --- |
| `E` oder Klick | Platzieren / Impuls |
| `Q` / `R` | Drehen |
| Leertaste | Modus wechseln |

Für eine XR-Session am PC: Immersive-Web-Emulator für Chromium installieren, `immersive-ar` wählen, Hit-Test/Ebenen im Emulator aktivieren.

## Docker & GHCR

Image (öffentlich): `ghcr.io/l8tenever/nova-xr:latest` und `ghcr.io/l8tenever/nova-xr:<git-sha>`.

Bei jedem Push auf `main` baut `.github/workflows/docker-publish.yml` das Image und pusht es nach GHCR. `ARG GIT_COMMIT` landet als Image-Label und `GIT_COMMIT`-Env (sichtbar unter `/api/version`).

`docker-compose.yml` **baut nicht lokal**, sondern zieht das GHCR-Image:

```bash
cp .env.example .env
# PUBLIC_URL nur lokal setzen, niemals committen
docker compose pull
docker compose up -d
```

Port über `NOVA_PORT` (Standard `8080`). Healthcheck und `restart: unless-stopped` sind gesetzt.

Erstes Pull: das Package in GitHub unter *Packages* ggf. auf **Public** stellen. Vor dem ersten erfolgreichen Workflow-Lauf existiert das Image noch nicht.

## HTTPS-Deployment

WebXR verlangt ein sicheres Origin (HTTPS oder localhost).

1. Auf dem Host `docker compose up -d` (Port z. B. über `NOVA_PORT`).
2. Davor einen HTTPS-Reverse-Proxy oder vergleichbaren TLS-Abschluss auf den Container-Port legen.
3. Die öffentliche URL **nur** in der lokalen `.env` als `PUBLIC_URL` eintragen (siehe `.env.example`).
4. Im Quest-Browser ausschließlich diese HTTPS-URL öffnen.

`.env.example` enthält nur Platzhalter. Keine echten Hostnamen, IPs oder Infrastruktur-Pfade ins Repo schreiben.

## Projektstruktur

```
app/main.py                 FastAPI: /health, /api/version, statisches Frontend
frontend/js/                three.js WebXR, Physik, Figur
frontend/assets/models/     character.glb + LICENSE
Dockerfile                  inkl. GIT_COMMIT Label/Env
docker-compose.yml          Image von GHCR, Port per Env
.github/workflows/          GHCR Build/Push bei Push auf main
```
