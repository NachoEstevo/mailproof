# MailProof

**Turn emails into private proofs.**

Convertí un email auténtico en una prueba privada y de un solo uso para una aplicación de Midnight.

> **MailProof permite demostrar una afirmación contenida en un email auténtico sin entregar el email completo.**

La empresa que envía el email no tiene que integrar Midnight. La aplicación que consume la prueba, sí.

---

## Estado

**Funcionando end-to-end sobre una devnet local de Midnight.**

- Contrato Compact desplegado: verificación Schnorr in-circuit, binding del sujeto por witness privado, nullifiers de un solo uso. 18 tests de circuito + golden vectors.
- Attestor HTTP con verificación criptográfica real: **DKIM-direct** (RSA-SHA256 del propio email contra la clave publicada del emisor, RFC 6376 — ver `docs/DECISIONS.md` D-007), con el seam de ZK Email construido y ruteado por blueprint para cuando el blueprint esté compilado en el registry.
- Demo web: soltás el `.eml`, se verifica la firma RSA, el attestor firma el claim, Midnight lo aprueba (~25s de proving real) y el replay se rechaza con `claim already used`.
- 139 tests. Corridas e2e consecutivas verificadas contra la cadena.

```bash
docker compose up -d --wait node indexer
npm install && npm run demo:reset
npm run attestor:dev   # terminal 1
npm run web:dev        # terminal 2  →  http://127.0.0.1:3000
```

Runbook completo: [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md). Qué es real y qué no, sin maquillaje: [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).

- Proyecto: Hack Buenos Aires 2026
- Licencia: Apache-2.0

## El problema

Muchas organizaciones ya emiten evidencia digital por email: cancelaciones de vuelo, recibos, admisiones, ofertas laborales, registros a eventos. Para usar esa evidencia hoy reenviamos el mensaje completo o subimos una captura.

Eso genera cuatro problemas: exceso de datos, fraude sencillo (una captura se edita), fricción para el usuario e integración costosa para el verificador.

## La propuesta

El email ya viene firmado con DKIM. ZK Email puede probar una afirmación del mensaje sin revelarlo. MailProof adapta esa prueba al modelo de Midnight y Compact administra el estado del claim.

```text
.eml local
   │  el email nunca sale del dispositivo
   ▼
ZK Email prover           verifica DKIM, dominio y template
   │  proof + outputs mínimos
   ▼
MailProof Attestor        re-verifica el proof y firma un claim canónico
   │  ClaimAttestationV1 firmado
   ▼
Compact / Midnight        verifica firma, campaña, binding y nullifier
   │
   ▼
Claim aprobado una sola vez
```

Decisión técnica central:

> **ZK Email verifica el email. Un attestor verifica ese proof y firma un claim canónico. Compact verifica la firma, el contexto y el nullifier.**

### Quién integra qué

| Parte | ¿Integra MailProof? | Trabajo requerido |
|---|---|---|
| Emisor (aerolínea, tienda, evento) | No | Envía su email normal con DKIM |
| Usuario | Usa la interfaz | Selecciona o carga el `.eml` |
| DApp consumidora (aseguradora) | Sí | Verifica el claim y ejecuta la acción |
| Midnight | Sí | Verifica la firma y registra el claim |
| ZK Email | Ya existe | Genera y verifica la prueba del email |

## Caso de demo

**Proof of Flight Cancellation.** Una aerolínea cancela un vuelo y manda un email con nombre, reserva, precio y otros datos. La aseguradora sólo necesita saber que existe un email auténtico del dominio esperado que confirma una cancelación y que ese claim no fue usado antes. MailProof le entrega exactamente eso.

Fallback documentado: **Proof of Event Registration** (blueprint de Luma, ya existente en ZK Email).

## Trust boundary

El plan es explícito sobre lo que no garantiza:

- **El attestor es confiable en el MVP.** Si firma un claim falso, Compact lo acepta. El roadmap es threshold attestation o verificación directa del proof.
- **DKIM no prueba verdad objetiva.** Prueba que un dominio firmó un mensaje que satisface el template. No que el hecho descrito sea cierto.
- **Posesión del `.eml` no es control del inbox.** Para eso hace falta un challenge fresco.

Ver [sección 41 — Threat model](docs/03-tests-security-fallbacks.md) y el Apéndice K.

## Documentación

Empezar por [`docs/README.md`](docs/README.md).

| Parte | Contenido |
|---|---|
| [00 — Intro](docs/00-intro.md) | Resumen y cómo usar el plan |
| [01 — Producto y arquitectura](docs/01-product-and-architecture.md) | Problema, propuesta, claim schema, nullifier, privacidad, contrato, attestor, blueprint |
| [02 — Implementación](docs/02-implementation.md) | Versiones pinneadas y Gates 0–12 |
| [03 — Tests, seguridad y fallbacks](docs/03-tests-security-fallbacks.md) | Matrices de tests, threat model, errores, fallback ladder |
| [04 — Demo, pitch y negocio](docs/04-demo-pitch-business.md) | Runbook, guion, Q&A, deck, checklist de submission |
| [05 — Handoff para el agente](docs/05-agent-handoff.md) | Contrato operativo, master prompt, apéndices A–L |

## Orden de implementación

El proyecto es contract-first. El orden no se invierte.

```text
1. Entorno            5. Attestor bridge     9. Deployment
2. Compact compile    6. CLI end-to-end     10. Submission
3. Contract tests     7. Frontend
4. ZK Email spike     8. Demo
```

No empezar por el frontend. No empezar por Gmail OAuth. No implementar RSA/DKIM en Compact.

## Stack de referencia

```text
Node.js 22+ · Docker Compose v2
Compact toolchain 0.31.1 · Compact runtime 0.16.0
Midnight.js 4.1.1 · DApp Connector API 4.0.1
Proof server 8.1.0 · Indexer 4.3.3
@zk-email/sdk 2.0.11 (pin exacto)
```

Fuente de verdad: la [compatibility matrix oficial de Midnight](https://github.com/midnightntwrk/midnight-docs/blob/main/docs/relnotes/support-matrix.json).

## Créditos

Construido sobre [ZK Email](https://docs.zk.email/) y [Midnight](https://docs.midnight.network/). MailProof no reemplaza a ZK Email: aporta la semántica de claims, el bridge de attestation, el consumo en Compact y la UX.

## Licencia

[Apache-2.0](LICENSE)

---

> **Your inbox already knows. MailProof lets you prove it.**
