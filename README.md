# Nova

WebXR-Passthrough-App für den **Meta Quest Browser**: eine Figur im echten Raum platzieren, drehen, verschieben und anschubsen. Die Figur steht mit **Muskelphysik** (aktiver Ragdoll): Sie gibt bei Stößen nach, schwankt, macht Ausfallschritte und fällt erst bei sehr starken Stößen – danach steht sie wieder auf.

Backend: **FastAPI + uvicorn** (inkl. Modell-Upload). Frontend: **three.js 0.180**, **cannon-es 0.20**, **@pixiv/three-vrm 3.4** (per CDN-Importmap, kein Build-Schritt).

WebXR braucht HTTPS (oder localhost). Die öffentliche Basis-URL gehört nur in die lokale `.env` als `PUBLIC_URL`, nicht ins Repository. Platzhalter: `https://example.com`.

## Funktionen

- `immersive-ar` mit Passthrough; optionale Features `hit-test`, `plane-detection`, `mesh-detection`, `anchors`, `hand-tracking` (fehlt eines, greift ein Fallback, z. B. eine virtuelle Bodenebene).
- **Zwei klar getrennte Modi** – *Platzieren* und *Interaktion* – umschaltbar über HUD, A/X-Taste oder das VR-Menü.
- **VR-Menü**: schwebendes Panel vor dem Blick (Thumbstick drücken oder Knopf über der linken Handfläche). Bedienbar per Laser (Controller/Pinch-Ray) oder Finger-Tippen. Inhalt: Modus, Neu platzieren (Reticle auf Boden/Flächen), Drehen (Slider + Buttons), Größe, Muskelkraft, Aufstellen, Modellliste, Schließen.
- **Hand greifen und führen**: Grip bzw. Pinch/Faust nahe ihrer Hand (ca. 10 cm) greift sie. Ihre Hand folgt weich (kraftbegrenzter Antrieb + Arm-IK, kein Teleport), Schulter und Ellbogen gehen mit. Bei Zug macht sie Schritte hinterher, bei zu großem Abstand löst sich der Griff. Beide Hände einzeln, Highlight und Controller-Haptik.
- **Einstellungen** Größe (50–150 %) und Muskelkraft (20–200 %) werden im Browser gespeichert.
- **Platzieren**: Figur setzen, um die Hochachse drehen (Thumbstick, Trigger/Pinch halten + seitlich ziehen, Maus ziehen), verschieben (Thumbstick vor/zurück, Grip halten und ziehen). Position wird per XR-Anchor gehalten, wenn verfügbar.
- **Interaktion**: aktiver Ragdoll mit PD-artigen Gelenkmotoren, die der Idle-Animation folgen, Balance-Regelung, Ausfallschritten und Aufstehen. Stöße per Controller-Ray, Hand/Finger (Hand-Tracking) oder Mausklick. Raumflächen (Boden, Wände, Möbel aus Plane/Mesh-Detection) sind Kollisionskörper.
- **Eigene Modelle**: Upload von GLB, glTF (eingebettet) und VRM über die Web-Oberfläche (Desktop-tauglich), Auswahl, Umbenennen und Löschen. Das Standardmodell bleibt immer verfügbar.
- **Automatisches Skelett-Mapping** auf humanoide Knochennamen (Mixamo, VRM, Blender-/Unreal-/Unity-Namensschemata). VRM-Modelle nutzen das VRM-Humanoid und **Spring Bones** (Haare, Kleidung).

## Bedienung

### Meta Quest – Controller

| Eingabe | Aktion |
| --- | --- |
| Trigger kurz | Figur an die Zielstelle setzen |
| Trigger halten + seitlich ziehen | Figur drehen |
| Thumbstick links/rechts | Figur drehen |
| Thumbstick vor/zurück | Figur verschieben |
| Grip halten | Figur am Boden mitziehen |
| A / X | Modus wechseln (Platzieren ↔ Interaktion) |
| B / Y | Figur wieder aufstellen |
| Interaktion: Trigger auf Figur | Stoß; Grip + Trigger = starker Stoß |
| Thumbstick drücken | VR-Menü öffnen/schließen (die Quest-Menütaste ist in WebXR meist nicht verfügbar) |
| Trigger auf Menü | Button drücken bzw. Slider ziehen |
| Grip nahe ihrer Hand | Hand greifen und führen (wechselt automatisch in Interaktion) |

### Meta Quest – Hand-Tracking

- Pinch kurz: setzen · Pinch halten + Hand seitlich bewegen: drehen.
- Linke Handfläche zum Gesicht drehen: Menü-Knopf über der Handfläche erscheint – mit dem rechten Zeigefinger antippen. Das Panel wird per Finger-Tippen oder Pinch-Ray bedient.
- Pinch oder Faust nahe ihrer Hand: Hand greifen; öffnen = loslassen.
- Interaktion: Figur mit Hand und Fingern direkt anschubsen.

### Desktop

Klick: setzen · Ziehen: drehen · `Q`/`E`: drehen · Leertaste: Modus · `R`: aufstellen · `N`: nächstes Modell · `P`: neu platzieren · `M`: 3D-Menü (wie in der Brille, per Maus bedienbar) · rechte Maustaste: Kamera · Mausrad: Zoom · im Interaktionsmodus Klick auf die Figur = Stoß, Shift + Klick = starker Stoß.

Hand greifen: Maus über ihre Hand (Highlight), gedrückt halten und ziehen; das Mausrad schiebt die gegriffene Hand dabei nach vorn/hinten.

Für eine XR-Session am PC eignet sich der Immersive-Web-Emulator für Chromium (`immersive-ar`).

## Eigene Modelle hochladen

Upload, Umbenennen und Löschen sind durch ein Token geschützt (`UPLOAD_TOKEN` in der `.env`). Ohne gesetztes Token ist das Hochladen deaktiviert (HTTP 403); Anzeigen und Auswählen funktioniert immer.

- **Web-UI**: Bereich *Modelle verwalten* im HUD. Token eintragen (wird nur mit Haken „merken“ im Browser gespeichert), Datei wählen, optional Namen vergeben.
- **Formate**: `.glb`, `.vrm` (VRM 0.x und 1.0), `.gltf` nur mit eingebetteten Daten (`data:`-URIs). Geprüft werden Dateiendung, GLB-Header bzw. JSON-Struktur und glTF-Version 2.x.
- **Limits**: `MAX_UPLOAD_MB` (Standard 100) und `MAX_MODELS` (Standard 50).
- **Speicherort**: `NOVA_MODELS_DIR` (im Container `/data/models`, als Docker-Volume persistent).

Beispiel per curl (lokal):

```bash
curl -X POST "http://localhost:8080/api/models?filename=figur.vrm&name=Meine%20Figur" \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @figur.vrm
```

API-Überblick:

| Methode | Pfad | Auth |
| --- | --- | --- |
| GET | `/api/models` | – |
| GET | `/api/models/{id}` / `/api/models/{id}/file` | – |
| POST | `/api/models?filename=…&name=…` (Rohdaten im Body) | Token |
| PATCH | `/api/models/{id}` (`{"name": "…"}`) | Token |
| DELETE | `/api/models/{id}` | Token |

Token wird als `Authorization: Bearer …` oder `X-Upload-Token: …` gesendet. Nach 10 Fehlversuchen in 5 Minuten antwortet der Server pro Client-IP mit 429.

Hochgeladene Modelle sind für jeden lesbar, der die App erreicht.

## Konfiguration (`.env`)

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `NOVA_PORT` | Host-Port | `8080` |
| `PUBLIC_URL` | öffentliche HTTPS-URL (nur Doku/lokal) | `https://example.com` |
| `UPLOAD_TOKEN` | Token für Upload/Umbenennen/Löschen | leer = Upload aus |
| `MAX_UPLOAD_MB` | maximale Dateigröße | `100` |
| `MAX_MODELS` | maximale Anzahl hochgeladener Modelle | `50` |

`.env.example` enthält nur Platzhalter. Ein Token z. B. mit `openssl rand -hex 32` erzeugen.

## Docker & GHCR

Image: `ghcr.io/l8tenever/nova-xr-app:latest` und `ghcr.io/l8tenever/nova-xr-app:<git-sha>`.

Der alte Package-Name `nova-xr` war noch mit einem umbenannten Repository verknüpft; dorthin durfte der `GITHUB_TOKEN` nicht schreiben (`write_package` verweigert). Deshalb wird jetzt unter dem neuen Namen `nova-xr-app` veröffentlicht. Das Label `org.opencontainers.image.source` zeigt auf dieses Repository, sodass der erste Push das Package neu anlegt und mit diesem Repo verknüpft. Danach das Package unter *Packages → Package settings* bei Bedarf auf **Public** stellen.

`.github/workflows/docker-publish.yml` führt zuerst die Tests aus (pytest, Node-Tests, Smoke-Test), baut dann das Image und pusht es bei Pushes auf `main`. Pull Requests bauen nur, ohne Push.

Der Container läuft als Nicht-Root-Benutzer, die Modelle liegen im Volume `nova-models` unter `/data/models`:

```bash
cp .env.example .env
# UPLOAD_TOKEN und PUBLIC_URL nur lokal setzen, niemals committen
docker compose pull
docker compose up -d
```

Lokal bauen: `docker build -t nova-xr-app .`

## HTTPS-Deployment

WebXR verlangt ein sicheres Origin (HTTPS oder localhost).

1. Auf dem Host `docker compose up -d`.
2. Davor einen HTTPS-Reverse-Proxy (TLS-Abschluss) auf den Container-Port legen. Für Uploads bis 100 MB muss der Proxy entsprechend große Request-Bodies erlauben.
3. Die öffentliche URL **nur** in der lokalen `.env` als `PUBLIC_URL` eintragen.
4. Im Quest-Browser diese HTTPS-URL öffnen, **AR starten** tippen.

## Lokal entwickeln und testen

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
UPLOAD_TOKEN=dev-token uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

Tests:

```bash
pytest -q                       # Backend inkl. Upload-API, Auth, Limits
npm ci && npm test              # Physik/Skelett-Mapping (Node, headless)
node frontend/js/smoke.node.mjs # Frontend-Smoke-Test
npm run test:e2e                # Browser-E2E (Desktop + emulierte Quest 3 via IWER)
```

`test:e2e` braucht eine laufende App (`NOVA_URL`, Standard `http://localhost:8080`) und ein lokales Chrome (`CHROME_PATH`, Standard `/usr/bin/google-chrome`); optional legt `SHOTS=<ordner>` Screenshots ab. Die E2E-Tests laufen nicht in der CI. Mit `?debug` in der URL stellt die App ein Debug-Objekt `window.nova` bereit, das die E2E-Tests nutzen.

Die Node-Abhängigkeiten in `package.json` sind nur für die Tests; die App lädt dieselben Versionen zur Laufzeit per CDN.

## Modell und Lizenz

Die mitgelieferte `frontend/assets/models/character.glb` ist byte-identisch mit `examples/models/gltf/Soldier.glb` aus dem three.js-Repository (Mixamo-Figur, Clips Idle/Walk/Run). Frühere Versionen dieser README nannten fälschlich ein Grab3D-Modell (CC0) als Quelle. Die Lizenzlage ist **nicht abschließend geklärt** – Details in `frontend/assets/models/LICENSE.txt`. Für eine Weiterverbreitung sollte das Standardmodell durch ein Modell mit eindeutiger Lizenz ersetzt werden.

## Physik im Detail

- 13 Körpersegmente (Becken, Rumpf, Kopf, Ober-/Unterarme, Ober-/Unterschenkel, Füße) als Boxen, Masse ca. 62 kg, Gelenke mit anatomischen Grenzen (Knie/Ellbogen als Scharniere nur in eine Richtung).
- Muskeln: Rotationsmotoren je Gelenk, die die Zielpose der Animation mit begrenzter Kraft anfahren – daher nachgiebig statt steif.
- Balance: Aufrichte- und Schwerpunktregelung, Standfüße, Ausfallschritte nach dem Capture-Point-Prinzip (bis zu 5 Schritte in Folge).
- Sturz: bei starker Neigung, zu niedriger Hüfte oder hoher Geschwindigkeit werden die Muskeln schlaff; nach kurzer Pause steht die Figur wieder auf. Gelingt das nicht, wird sie automatisch zurückgesetzt. B/Y bzw. `R` stellt sie jederzeit auf.
- Fester Zeitschritt 1/120 s.
- Hand greifen: ein kraftbegrenzter Punkt-Antrieb (Geschwindigkeits-Constraint mit Vorsteuerung) zieht den Handpunkt des Unterarms zum Ziel; eine Zwei-Knochen-IK setzt dazu die Muskelziele von Schulter und Ellbogen, der Arm ist dabei weicher. Schultergelenk bis 145° mit eigener Swing-Twist-Begrenzung; das Schlüsselbein wird beim Heben rein optisch mitgedreht.
- Griff löst sich bei Abstand über ca. 65 cm, bei länger anhaltender Überdehnung oder wenn sie fällt. Zieht man über die Armlänge hinaus, verschiebt sich der Schrittpunkt – sie geht hinterher. Nach dem Loslassen werden Muskelkraft und Gelenkgeschwindigkeit über 0,9 s hochgefahren (sanfte Rückkehr in die Idle-Pose).
- Muskelkraft skaliert die Gelenkmotoren und (nur nach oben) die Balance-Hilfen; sehr niedrige Werte lassen sie zusammensacken.

## Grenzen

- Nicht auf echter Quest-Hardware getestet, nur im Desktop-Browser (Headless-Chrome), im Quest-3-Emulator (IWER) und in Node-Tests. Pinch-/Faust-Schwellen und Handflächen-Geste sind auf echtem Hand-Tracking nicht abgestimmt.
- Menü per Thumbstick-Druck statt Menütaste. Das Schlüsselbein-Heben ist kosmetisch, die sichtbare Hand kann daher einige cm vom Physik-Griffpunkt abweichen. Der Schulter-Kegel ist symmetrisch und erlaubt zu viel Rückschwung.
- Greifen nur, während sie steht (nicht liegend/beim Aufstehen). Controller-/Hand-Kollider sind im Umkreis von 18 cm ihrer Hand deaktiviert, damit man sie nicht wegschiebt.
- Skalieren ändert die Masse nicht; Drehen/Skalieren im Interaktionsmodus baut den Ragdoll nach 0,6 s neu auf.
- Das Aufstehen wird durch Hilfskräfte am Becken unterstützt und ist keine natürliche Aufsteh-Animation.
- Die Balance nutzt zusätzlich unterstützende Kräfte (Aufrichten, Schwerpunkt) – kein rein muskelgetriebenes Stehen.
- Modelle ohne erkennbare Beine/Arme/Wirbelsäule werden angezeigt, aber ohne Physik.
- Spring Bones nur bei VRM; GLB-Modelle ohne Idle-Clip bekommen eine prozedurale Idle-Pose.
- Draco/KTX2/Meshopt-Decoder und alle Bibliotheken kommen vom CDN (jsdelivr); offline startet die App nicht.

## Projektstruktur

```
app/main.py               FastAPI: Health, Version, Modell-API, statisches Frontend
app/models_store.py       persistente Modellablage (Datei + Metadaten-JSON)
app/model_inspect.py      Prüfung von GLB/glTF/VRM, Humanoid-Erkennung
frontend/js/main.js       App-Logik, Modi, Eingabe
frontend/js/active-ragdoll.js   Muskelphysik, Balance, Schritte, Aufstehen
frontend/js/physics-world.js    cannon-es-Welt, Raumkollider, Hände
frontend/js/humanoid-map.js     Skelett-Mapping
frontend/js/character.js        Laden (GLB/VRM), Idle, Platzierung
frontend/js/xr-session.js       WebXR-Session, Hit-Test, Anchors, Raum
frontend/js/xr-menu.js          schwebendes VR-Menü (Laser, Finger-Tippen, Handflächen-Knopf)
frontend/js/menu-layout.js      Menü-Layout und Hit-Test (rein, testbar)
frontend/js/hand-grab.js        Greifen ihrer Hände (Highlight, Haptik)
frontend/js/models-ui.js        Modellverwaltung/Upload-UI
tests/                    pytest (Backend, Frontend-Smoke)
frontend/tests/           Node-Tests (Physik, Greifen, Menü, Mapping)
frontend/tests/e2e/       Browser-E2E (Desktop, emulierte Quest 3)
```
