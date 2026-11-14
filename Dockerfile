# 多阶段构建：运行镜像只含一个静态二进制 + 基础 CA 证书，无第三方依赖。
# 若 golang:1.27-alpine 暂不可用，可改为 golang:alpine（需 >= go.mod 中的版本）。
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web/ ./web/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /lanshare .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates \
    && adduser -D -u 10001 lanshare
COPY --from=build /lanshare /usr/local/bin/lanshare
USER lanshare
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/lanshare"]
CMD ["-no-tls", "-addr", ":8080"]
