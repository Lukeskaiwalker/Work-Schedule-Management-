# SMPL update runner — sidecar that owns docker-socket access for orchestrating
# safe_update.sh runs without giving the api container itself root on the host.
#
# Base image rationale: python:3.12-alpine is the cleanest way to get a working
# pip + venv layer. We add docker-cli + the compose plugin via Alpine community
# packages so the runner can drive `docker compose` against the host socket.
# Final image stays small (~140MB).
FROM python:3.12-alpine

# - docker-cli + docker-cli-compose: drive the host's docker daemon
# - git: required by safe_update.sh --pull
# - openssl: required by backup.sh for AES-256 encryption
# - bash: safe_update.sh / backup.sh shebangs assume bash (set -euo pipefail)
# - coreutils: provides `stdbuf`, which the runner uses to force line-buffering
#   on the subprocess's stdout. Without it, bash's printf to a pipe is full-
#   buffered (4KB blocks) by libc, so v2.3.2 progress markers from backup.sh
#   got batched and only flushed at script exit — making the stage UI silent
#   until the very end. See v2.3.3 release notes for the user-visible symptom.
# - curl: for the healthcheck and ad-hoc diagnostics
RUN apk add --no-cache \
        docker-cli \
        docker-cli-compose \
        git \
        openssl \
        bash \
        coreutils \
        curl

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 9000

# `--workers 1` because the runner serializes jobs through an in-process lock;
# multiple workers would each accept a "single active job" claim independently
# and break that invariant.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9000", "--workers", "1"]
