# Moat Cloud: Helm chart

Self-hosting on Kubernetes (FR-60, SEC-57). One Deployment (API and dashboard from one origin),
Service, optional Ingress, a default-deny NetworkPolicy and an optional PodDisruptionBudget. The
database is an **external PostgreSQL**; this chart does not run one.

> **Honest limits (chart 0.2.0).** Rendered with `helm lint`, `helm template` and kubeconform
> (Kubernetes 1.30) in every supported configuration (`pnpm check:helm`, also in CI), but **never
> installed on a cluster**. There is no published image before the first release: build it with
> `deploy/docker/Dockerfile` (see `deploy/docker/README.md`) and set `image.repository` and
> `image.tag`. No e-mail, no gates in the Cloud, no TLS termination (the ingress does that).

## Database: PostgreSQL or SQLite

| `database.provider`    | What                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgresql` (default) | An external server, verified TLS; any number of replicas.                                                                                                                                                                                                                        |
| `sqlite`               | One file on a PersistentVolumeClaim (`database.sqlite.*`): **one replica**, strategy `Recreate`. No database server to run; fine for a small installation. The claim is created with `helm.sh/resource-policy: keep` (it survives `helm uninstall`), or name an `existingClaim`. |

With `sqlite` no database Secret is needed and the NetworkPolicy has no database egress; with
`replicaCount` above 1 the chart refuses to render.

## Secrets (never in values.yaml)

The account key must exist before the install (with `postgresql` also the database URL and the CA). The chart only references them by name.

```bash
kubectl create secret generic moat-account-key \
  --from-literal=moat_account_key="$(head -c 32 /dev/urandom | basenc --base64url | tr -d '=')"
kubectl create secret generic moat-database-url \
  --from-literal=moat_database_url='postgresql://moat:<password>@<host>:5432/moat?sslmode=verify-full'
kubectl create secret generic moat-database-ca --from-file=ca.crt=./db-ca.crt
```

The Cloud refuses a database connection without verified TLS towards another host.

## Install (SQLite, the smallest setup)

```bash
kubectl create secret generic moat-account-key \
  --from-literal=moat_account_key="$(head -c 32 /dev/urandom | basenc --base64url | tr -d '=')"
helm install moat deploy/helm/moat-cloud \
  --set image.repository=ghcr.io/<owner>/moat-cloud --set image.tag=<release> \
  --set publicOrigin=https://moat.example.ch \
  --set secrets.accountKey.name=moat-account-key \
  --set database.provider=sqlite \
  --set ingress.enabled=true --set ingress.host=moat.example.ch --set ingress.tlsSecretName=moat-tls
```

## Install (PostgreSQL)

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
