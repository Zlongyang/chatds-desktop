ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 sandbox && useradd -u 10001 -g 10001 -M sandbox \
    && mkdir -p /workspace && chown 10001:10001 /workspace
LABEL org.chatds.sandbox.version="1"
WORKDIR /workspace
USER 10001:10001
VOLUME /workspace
CMD ["node", "--version"]
