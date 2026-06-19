FROM rust:1.89-alpine AS build
WORKDIR /app
RUN apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static
COPY rust-service/Cargo.toml ./Cargo.toml
COPY rust-service/src ./src
RUN cargo build --release

FROM alpine:3.21
WORKDIR /app
RUN apk add --no-cache ca-certificates
COPY --from=build /app/target/release/yeet-bet-processor-rust /usr/local/bin/yeet-bet-processor-rust
COPY sql ./sql
ENV RUST_PORT=3001
CMD ["yeet-bet-processor-rust"]
