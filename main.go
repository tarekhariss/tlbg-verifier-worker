// Minimal HTTP wrapper around the open-source AfterShip email-verifier
// Go library (MIT). Exposes the same shape worker.mjs already consumes:
//
//   GET /v1/:email/verification  -> JSON result
//   GET /healthz                 -> "ok"
//
// Build & run via the local Dockerfile — no private registry images.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	emailverifier "github.com/AfterShip/email-verifier"
)

var verifier = emailverifier.
	NewVerifier().
	EnableSMTPCheck().
	EnableAutoUpdateDisposable()

func main() {
	// SMTP check requires outbound port 25. Allow disabling via env for
	// environments where 25 is blocked (most PaaS, including Railway free).
	if os.Getenv("DISABLE_SMTP_CHECK") == "1" {
		verifier = verifier.DisableSMTPCheck()
		log.Println("[engine] SMTP check disabled via DISABLE_SMTP_CHECK=1")
	}
	if helo := os.Getenv("SMTP_HELO_NAME"); helo != "" {
		verifier = verifier.HelloName(helo)
	}
	if from := os.Getenv("SMTP_FROM_EMAIL"); from != "" {
		verifier = verifier.FromEmail(from)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/v1/", handleVerify)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("[engine] listening on :%s", port)
	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  35 * time.Second,
		WriteTimeout: 35 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// /v1/{email}/verification
func handleVerify(w http.ResponseWriter, r *http.Request) {
	// Expect path: /v1/{email}/verification
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/"), "/")
	if len(parts) < 2 || parts[1] != "verification" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	raw, err := url.PathUnescape(parts[0])
	if err != nil || raw == "" {
		http.Error(w, "bad email", http.StatusBadRequest)
		return
	}

	res, err := verifier.Verify(raw)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}
