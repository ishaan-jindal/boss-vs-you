FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app

# uv for fast installs; no model weights — API only.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY pyproject.toml ./
RUN uv pip install --system --no-cache -e .

COPY src/ src/
COPY static/ static/

EXPOSE 8000
CMD ["sh", "-c", "uvicorn bossfight.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
