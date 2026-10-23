FROM ghcr.io/astral-sh/uv:0.7.2 AS uv
FROM python:3.13-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /build
ENV UV_PROJECT_ENVIRONMENT=/opt/venv
COPY backend/pyproject.toml backend/uv.lock ./
COPY backend/src ./src
RUN uv sync --locked --no-dev --no-editable --python /usr/local/bin/python

FROM python:3.13-slim
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["python", "-m"]
CMD ["freelance.bootstrap.api", "--container"]
