# docker/pocketbase/Dockerfile
# Build arg is wired to POCKETBASE_VERSION by CI so the image tag and the binary
# stay in lockstep with src/lib/pocketbase-version.ts.
FROM alpine:3.20

ARG POCKETBASE_VERSION
ARG TARGETARCH=amd64

RUN apk add --no-cache ca-certificates unzip wget \
  && wget -O /tmp/pb.zip \
     "https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_linux_${TARGETARCH}.zip" \
  && unzip /tmp/pb.zip -d /usr/local/bin/ \
  && rm /tmp/pb.zip \
  && chmod +x /usr/local/bin/pocketbase

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# /pb-code is the read-only code mount; /pb-data is the persistent volume.
VOLUME ["/pb-data"]
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
