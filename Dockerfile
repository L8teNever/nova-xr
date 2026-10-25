FROM python:3.12-slim

ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.revision=$GIT_COMMIT \
      org.opencontainers.image.title="Nova XR" \
      org.opencontainers.image.source="https://github.com/l8tenever/nova-xr"

ENV GIT_COMMIT=$GIT_COMMIT \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY scripts/fetch-character.sh ./scripts/fetch-character.sh
COPY app ./app
COPY frontend ./frontend
# python:*-slim has no curl (and no bash). Fetch is a fallback if the GLB is absent.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && chmod +x ./scripts/fetch-character.sh \
    && ./scripts/fetch-character.sh ./frontend/assets/models/character.glb

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
