# Makefile for the Bitopia daemon (officed).
# The daemon uses only the Go standard library; no `go get` is required or used.

.PHONY: all build test vet run clean verify

BIN := bin/officed

all: verify build

build:
	go build -o $(BIN) ./cmd/officed

test:
	go test ./...

vet:
	go vet ./...

# verify runs the full offline gate: vet, build, test.
verify: vet build test

run: build
	./$(BIN)

clean:
	rm -rf bin
