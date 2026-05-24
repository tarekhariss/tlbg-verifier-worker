FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod ./
RUN go mod download

COPY main.go ./
RUN go build -o email-verifier main.go

FROM alpine:3.20

WORKDIR /app

COPY --from=builder /app/email-verifier ./email-verifier

EXPOSE 8080

CMD ["./email-verifier"]
