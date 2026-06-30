-- Reference schema for the surge15 route-sharing API.
-- The app also creates this table automatically on first run (see api/index.js),
-- so running this by hand is optional.

CREATE TABLE IF NOT EXISTS shared_routes (
    code        text PRIMARY KEY,             -- 8-char uppercase alphanumeric share code
    name        text NOT NULL,                -- route name (from the POST body)
    route_json  text NOT NULL,                -- full original POST body, stored verbatim
    created_at  timestamptz NOT NULL DEFAULT now()
);
