# Always-on rent-stabilized listings server (Rust). Builds only the server
# crate; the desktop app is not needed in the image.
#
#   docker build -t rent-stabilized .
#   docker run -d -p 8787:8787 -v rs-data:/data -e API_KEY=change-me rent-stabilized

FROM rust:1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p reasier-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home /data app && mkdir -p /data && chown app /data
COPY --from=build /src/target/release/reasier-server /usr/local/bin/reasier-server
COPY data/rgb_buildings.json /app/rgb_buildings.json
USER app
ENV BIND_ADDR=0.0.0.0 PORT=8787 DB_PATH=/data/reasier.db RGB_PATH=/app/rgb_buildings.json \
    SYNC_INTERVAL_SECS=3600
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD ["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8787"]
CMD ["reasier-server"]
