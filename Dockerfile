# syntax=docker/dockerfile:1
# 多阶段构建：运行镜像只含一个静态二进制 + 基础 CA 证书，无第三方依赖。
# 若 golang:1.27-alpine 暂不可用，可改为 golang:alpine（需 >= go.mod 中的版本）。

# 编译阶段固定跑在构建机原生架构上，用 Go 交叉编译出目标平台二进制：
# buildx 多平台构建时无需 QEMU 模拟整个 Go 工具链，也避免目标架构缺少
# golang 基础镜像。普通 docker compose build 下 TARGET* 为空，回退到
# linux + 构建机架构，行为与原来一致。
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web/ ./web/
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
RUN set -eu; \
    os="${TARGETOS:-linux}"; \
    arch="${TARGETARCH:-$(go env GOARCH)}"; \
    arm=""; \
    case "$TARGETVARIANT" in v5) arm=5 ;; v6) arm=6 ;; v7) arm=7 ;; esac; \
    echo "building GOOS=$os GOARCH=$arch GOARM=$arm"; \
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" GOARM="$arm" \
      go build -trimpath -ldflags="-s -w" -o /lanshare .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates \
    && adduser -D -u 10001 lanshare
COPY --from=build /lanshare /usr/local/bin/lanshare
USER lanshare
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/lanshare"]
CMD ["-no-tls", "-addr", ":8080"]
