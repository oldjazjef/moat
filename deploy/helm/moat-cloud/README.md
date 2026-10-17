# Moat Cloud: Helm chart

Self-hosting on Kubernetes (FR-60, SEC-57). One Deployment (API and dashboard from one origin),
Service, optional Ingress, a default-deny NetworkPolicy and an optional PodDisruptionBudget. The
database is an **external PostgreSQL**; this chart does not run one.

> **Honest limits (chart 0.1.0).** Written and statically checked, **not installed on a cluster**,
> and `helm lint` / `kubeconform` were not run in the authoring environment (no `helm`). CI is
> expected to run both (CLAUDE.md, YAML standards). There is no published image yet: build it with
> `deploy/docker/Dockerfile` and set `image.repository` and `image.tag`. No e-mail, no gates in the
> Cloud, no audit log, no TLS termination (the ingress does that).

## Secrets (never in values.yaml)

Three Secrets must exist before the install. The chart only references them by name.

```bash
kubectl create secret generic moat-account-key \
  --from-literal=moat_account_key="$(head -c 32 /dev/urandom | basenc --base64url | tr -d '=')"
kubectl create secret generic moat-database-url \
  --from-literal=moat_database_url='postgresql://moat:<password>@<host>:5432/moat?sslmode=verify-full'
kubectl create secret generic moat-database-ca --from-file=ca.crt=./db-ca.crt
```

The Cloud refuses a database connection without verified TLS towards another host.

## Install

```bash
helm install moat deploy/helm/moat-cloud \
  --set image.repository=ghcr.io/<owner>/moat-cloud --set image.tag=<release> \
  --set publicOrigin=https://moat.example.ch \
  --set secrets.accountKey.name=moat-account-key \
  --set secrets.databaseUrl.name=moat-database-url \
  --set secrets.databaseCa.name=moat-database-ca \
  --set 'networkPolicy.databaseTo[0].ipBlock.cidr=10.0.5.12/32' \
  --set ingress.enabled=true --set ingress.host=moat.example.ch \
  --set ingress.tlsSecretName=moat-tls
```

The chart **refuses to render** without `image.tag` (and never `latest`), `publicOrigin`, the three
secret names, `networkPolicy.databaseTo` (an empty egress list would leave it open) and, with the
ingress on, a host and a TLS secret.

## What is hardened

Non-root (1000), `readOnlyRootFilesystem`, all capabilities dropped, no privilege escalation,
`seccompProfile: RuntimeDefault`, no ServiceAccount token, no service-link variables, `/tmp` in
memory, secrets as read-only files (mode 0440), probes on `/healthz` and `/readyz`, ingress and
egress denied except the ingress controller, DNS and the database port.

`trustProxy` must equal the number of proxies in front (the ingress controller = 1).
