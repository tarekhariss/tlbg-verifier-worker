# Build the AfterShip email-verifier Go library into a small HTTP service
# from source. No private registry images required.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download || true
COPY main.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -o /out/engine ./...

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/engine /usr/local/bin/engine
ENV PORT=8080
EXPOSE 8080
USER nobody
CMD ["/usr/local/bin/engine"]
