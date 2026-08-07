# 24. Versiones y prerequisitos

Usar versiones compatibles.

No usar `latest` de forma ciega.

## 24.1 Runtime

```text
Node.js: 22+
Docker Desktop: running
Docker Compose: v2
Git: current stable
```

## 24.2 Midnight

Matriz oficial de referencia revisada el 7 de agosto de 2026:

```text
Compact devtools: 0.5.1
Compact toolchain: 0.31.1
Compact runtime: 0.16.0
Compact JS: 2.5.1
Midnight.js: 4.1.1
testkit-js: 4.1.1
DApp Connector API: 4.0.1
Ledger: 8.1.0
Proof server: 8.1.0
Wallet SDK: 1.2.0
Indexer: 4.3.3
```

La quickstart oficial puede mostrar otra patch version.

Usar la compatibility matrix como fuente principal.

## 24.3 ZK Email

```text
@zk-email/sdk: 2.0.11
```

Pin exacto.

No actualizar durante el hackathon sin necesidad.

## 24.4 Verificación inicial

Ejecutar:

```bash
node --version
docker --version
docker compose version
compact compile --version
git --version
```

Guardar output en:

```text
docs/BUILD_LOG.md
```

---

# 25. Estrategia de implementación

La estrategia es contract-first.

El orden es obligatorio.

```text
1. Entorno
2. Compact compile
3. Contract tests
4. ZK Email proof spike
5. Attestor bridge
6. CLI end-to-end
7. Frontend
8. Demo
9. Deployment
10. Submission
```

No empezar por el diseño visual.

No empezar por Gmail OAuth.

No empezar por la integración con una aerolínea.

No empezar por un SDK genérico.

---

# 26. Gate 0 — Confirmar alcance con mentor

**Objetivo:** eliminar incertidumbre antes de codear.

**Tiempo máximo:** 30 minutos.

## 26.1 Preguntas

Preguntar:

1. ¿Compact puede verificar hoy un proof externo de ZK Email?
2. Si no, ¿aceptan un attestation bridge firmado?
3. ¿Recomiendan el patrón del tutorial ZK Loan?
4. ¿Qué red recomiendan para la demo?
5. ¿Local devnet es aceptable?
6. ¿Qué wallet recomiendan?
7. ¿Hay un ejemplo de firma que compile con el toolchain del evento?
8. ¿Usar una dependencia MIT como ZK Email es compatible con la regla net-new?
9. ¿El contrato puede tener un attestor confiable si el trust model es explícito?
10. ¿Qué parte quieren ver implementada en Compact?

## 26.2 Decisión

Registrar respuesta en:

```text
docs/DECISIONS.md
```

## 26.3 Criterio de salida

Existe una decisión escrita:

```text
DIRECT_EXTERNAL_PROOF = yes/no
ATTESTOR_BRIDGE = yes/no
TARGET_NETWORK = local/preview/preprod
SIGNATURE_PATTERN = ...
```

---

# 27. Gate 1 — Crear repo y compilar el primer contrato

**Objetivo:** superar el technical gate del hackathon.

## 27.1 Crear repo

Crear repo público.

Agregar:

```text
LICENSE: Apache-2.0
README.md
.gitignore
.nvmrc
```

Agregar label requerido:

```text
midnightntwrk
```

## 27.2 Scaffold

Usar:

```bash
npx create-mn-app mailproof
```

Elegir:

```text
Contract
hello-world
```

Razón:

- trae devnet local;
- trae node;
- trae indexer;
- trae proof server;
- trae CLI;
- reduce riesgo.

## 27.3 Verificar scaffold

Ejecutar:

```bash
cd mailproof
npm run setup
npm run test:e2e
npm run cli
```

## 27.4 Crear contrato vacío de MailProof

Reemplazar hello world con el mínimo.

Primera versión:

```text
ledger approvedClaimCount
circuit registerDemoClaim
```

No agregar firma todavía.

## 27.5 Tests

Crear test:

```text
initial count = 0
registerDemoClaim
count = 1
```

## 27.6 Criterio de salida

- `compact compile` pasa;
- `npm run setup` pasa;
- e2e pasa;
- una transacción cambia estado;
- commit creado.

Commit sugerido:

```text
feat(contract): establish compiling MailProof contract
```

## 27.7 Stop condition

Si no compila:

- no trabajar en ZK Email;
- no trabajar en UI;
- pedir ayuda;
- revisar versión;
- usar código mínimo;
- eliminar features.

---

# 28. Gate 2 — Diseñar y testear el claim Compact

**Objetivo:** Compact acepta un claim firmado de fixture.

ZK Email todavía no participa.

## 28.1 Crear ClaimAttestationV1

Definir tipos fijos.

Evitar strings.

## 28.2 Agregar attestor key

Constructor recibe o deriva la public key.

## 28.3 Implementar signature verification

Usar patrón validado.

## 28.4 Implementar nullifier set

Circuit:

```text
redeemClaim
```

Checks:

```text
signature
campaign
claimType
nullifier absent
subject binding
```

Effects:

```text
insert nullifier
increment counter
```

## 28.5 Crear fixture signer

Script TypeScript:

```text
scripts/sign-fixture-claim.ts
```

Este script genera un claim válido.

## 28.6 Contract tests

### Test C-01

Valid signature passes.

### Test C-02

Wrong signature fails.

### Test C-03

Changed claimType fails.

### Test C-04

Changed campaign fails.

### Test C-05

Changed nullifier fails.

### Test C-06

Replay fails.

### Test C-07

Wrong subject binding fails.

### Test C-08

Wrong attestor key fails.

## 28.7 Criterio de salida

El contrato acepta sólo el fixture válido.

El replay falla.

Todos los tests pasan.

Commit:

```text
feat(contract): verify signed one-time email claims
```

## 28.8 Fallback de firma

Si la firma no compila después de dos horas:

### Fallback A

Usar el patrón exacto del tutorial oficial ZK Loan.

### Fallback B

Attestor ejecuta un admin circuit autenticado.

Flow:

```text
proof verified
attestor calls approveClaim(nullifier)
```

Este fallback es menos fuerte.

Debe quedar documentado.

No usar un backend boolean sin un check Compact.

---

# 29. Gate 3 — Conseguir un email válido

**Objetivo:** tener un `.eml` apto para el blueprint.

## 29.1 Crear una cuenta de demo

Usar una cuenta creada para el hackathon.

No usar el inbox personal.

## 29.2 Opción de vuelo

Enviar un email real con un dominio DKIM.

Template estable:

```text
Subject: Flight MP123 cancelled

Hello Demo Passenger,

Your flight MP123 has been cancelled.

Booking reference: MP-2026-0001
Claim code: CLAIM-0001
```

## 29.3 Opción Luma

Usar un email real de registro de Luma.

El tutorial oficial ya documenta este claim.

## 29.4 Descargar `.eml`

Gmail:

```text
Open email
More
Download message
```

## 29.5 Inspeccionar

No editar el archivo.

Crear un script:

```text
scripts/inspect-eml.ts
```

Debe imprimir:

- headers;
- DKIM domains;
- selectors;
- signed headers;
- content types;
- length;
- candidate fields.

No imprimir body en logs compartidos.

## 29.6 Verificar DKIM

Antes de ZK proof, usar una librería estándar de DKIM o la validación del SDK.

Confirmar:

```text
DKIM valid
```

## 29.7 Fixture de privacidad

No commit del email real.

Opciones:

- `.gitignore` para `fixtures/private-emails`;
- commit sólo sample sintético permitido;
- commit proof pre-generado sin PII.

## 29.8 Criterio de salida

Existe un `.eml` que:

- tiene DKIM;
- no fue modificado;
- tiene template estable;
- tiene claim marker;
- tiene unique ID;
- puede usarse sin PII real.

---

# 30. Gate 4 — Crear o seleccionar el blueprint

**Objetivo:** el blueprint valida el email.

## 30.1 Decidir existing vs custom

### Existing

Preferido si:

- existe un claim útil;
- compila;
- reduce riesgo.

### Custom

Necesario para flight cancellation.

## 30.2 Crear blueprint

En el Registry de ZK Email:

1. login con GitHub;
2. create blueprint;
3. upload `.eml`;
4. set pattern name;
5. set sender domain;
6. set max header length;
7. set body cutoff;
8. define fields;
9. define regex;
10. compile;
11. test.

## 30.3 Header length

Usar múltiplo de 64.

Usar el mínimo que cubra el header.

Un valor muy grande aumenta el circuito.

## 30.4 Body cutoff

Usar el mínimo que incluye el claim.

No procesar attachments.

## 30.5 Skip body hash

Usar `false` si la cancelación está en body.

Usar `true` sólo si todo el claim está en headers firmados.

## 30.6 Fields

### Field A — cancellation marker

Debe probar una frase precisa.

Puede ser privado si el claim type es fijo.

### Field B — unique claim ID

Debe permitir nullifier.

Puede revelarse al attestor.

No debe ir crudo a Midnight.

### Field C — optional recipient

Sólo si se necesita binding.

### Field D — optional flight number

Puede mantenerse privado.

## 30.7 Test de template

Testear:

- email válido;
- una copia con una letra modificada;
- otro sender;
- otro subject;
- body truncado.

## 30.8 Criterio de salida

- blueprint compilado;
- slug exacto guardado;
- valid email accepted;
- tampered email rejected;
- docs actualizados.

Commit:

```text
docs(zk-email): pin flight cancellation blueprint
```

## 30.9 Fallback

Si custom blueprint no compila en 90 minutos:

- cambiar a Proof of Luma;
- no seguir arreglando regex compleja;
- registrar la decisión.

---

# 31. Gate 5 — ZK Email proof spike por CLI

**Objetivo:** generar y verificar un proof antes del frontend.

## 31.1 Instalar SDK

```bash
npm install --save-exact @zk-email/sdk@2.0.11
```

## 31.2 Crear script

```text
scripts/prove-email.ts
```

Responsabilidades:

1. leer `.eml`;
2. cargar blueprint;
3. validate;
4. crear local prover;
5. generar proof;
6. verificar proof;
7. imprimir public outputs redactados;
8. guardar proof fixture opcional;
9. medir duration.

## 31.3 Local proving

Usar:

```text
isLocal: true
```

## 31.4 Métricas

Registrar:

```text
validate duration
prove duration
verify duration
proof size
public output size
browser memory later
```

## 31.5 Proof fixture

Guardar un proof válido para backup.

Path:

```text
fixtures/proofs/flight-cancelled.valid.json
```

Revisar que no contenga PII.

Si contiene PII, no commitear.

## 31.6 Tests

### Z-01

Valid email proves.

### Z-02

Valid proof verifies.

### Z-03

Tampered email fails.

### Z-04

Wrong blueprint fails.

### Z-05

Wrong public output fails.

## 31.7 Criterio de salida

CLI genera proof.

CLI verifica proof.

El team sabe cuánto tarda.

Commit:

```text
feat(zk-email): generate and verify email claim proof
```

## 31.8 Stop condition

Si local proving no funciona:

1. revisar SDK example;
2. probar Node script;
3. probar browser;
4. usar existing blueprint;
5. usar proof fixture para el bridge;
6. no cambiar a remote proving sin documentar privacidad.

---

# 32. Gate 6 — Implementar el attestor

**Objetivo:** convertir un ZK Email proof válido en ClaimAttestationV1.

## 32.1 Crear service

Recomendado:

```text
services/attestor
```

Puede ser:

- Fastify;
- Express;
- Next.js route;
- Hono.

Elegir el stack más conocido por el equipo.

No optimizar.

## 32.2 Endpoint health

```text
GET /health
```

No mostrar secrets.

## 32.3 Endpoint attest

```text
POST /attest
```

## 32.4 Validar input

Usar Zod.

Reject unknown fields.

Set max body.

## 32.5 Cargar blueprint

Usar allowlist local.

No aceptar slug arbitrario.

Ejemplo:

```json
{
  "flight-cancel-v1": {
    "slug": "team/FlightCancellation@v1",
    "claimType": 1,
    "issuerDomainHash": "...",
    "campaignId": "..."
  }
}
```

## 32.6 Verificar proof

Usar:

```text
blueprint.verifyProofData(...)
```

o API equivalente confirmada en tipos instalados.

No confiar en un boolean del cliente.

## 32.7 Validar outputs

Comparar:

- claim marker;
- unique ID;
- sender config;
- blueprint version;
- context.

## 32.8 Derivar nullifier

Usar domain separation.

Ejemplo conceptual:

```text
H(
  "mailproof:nullifier:v1",
  blueprintIdHash,
  H(uniqueClaimId),
  campaignId
)
```

## 32.9 Derivar proof digest

```text
H(canonicalProofData || canonicalPublicOutputs)
```

## 32.10 Crear claim

Usar shared schema.

## 32.11 Firmar

Usar attestor key.

## 32.12 Responder

No incluir unique ID crudo.

## 32.13 Tests

### A-01

Valid proof receives signature.

### A-02

Invalid proof receives 400/422.

### A-03

Unknown blueprint rejected.

### A-04

Wrong campaign rejected.

### A-05

Tampered outputs rejected.

### A-06

Oversized payload rejected.

### A-07

Logs contain no email.

### A-08

Claim signature verifies in fixture verifier.

## 32.14 Criterio de salida

Un proof real produce un claim firmado.

Un proof inválido no produce firma.

Commit:

```text
feat(attestor): bridge verified email proofs to Midnight claims
```

---

# 33. Gate 7 — CLI end-to-end

**Objetivo:** probar todo sin frontend.

## 33.1 Script

```text
scripts/e2e-claim.ts
```

## 33.2 Flow

1. load proof fixture;
2. call attestor;
3. receive claim;
4. call Compact;
5. wait;
6. read state;
7. attempt replay;
8. confirm replay rejection.

## 33.3 Output esperado

```text
[1/6] Email proof loaded
[2/6] ZK Email proof verified
[3/6] MailProof claim signed
[4/6] Midnight transaction submitted
[5/6] Claim approved
[6/6] Replay rejected
```

## 33.4 Criterio de salida

E2E pasa tres veces seguidas.

No hay pasos manuales ocultos.

Commit:

```text
test(e2e): prove email claim and redeem on Midnight
```

## 33.5 Regla

No empezar UI si E2E CLI no pasa.

---

# 34. Gate 8 — Frontend

**Objetivo:** crear una experiencia simple.

## 34.1 Pantallas

### Screen 1 — Value

```text
Prove your flight was cancelled.
Keep your email private.
```

Button:

```text
Start claim
```

### Screen 2 — Connect

```text
Connect Midnight wallet
```

### Screen 3 — Upload

Dropzone:

```text
Drop cancellation email (.eml)
```

Privacy note:

```text
The email stays on this device.
```

### Screen 4 — Inspect

Mostrar datos localmente.

Redactar por defecto.

```text
Detected:
Trusted sender
Cancellation statement
Unique claim
```

### Screen 5 — Proving

Pasos:

```text
1. Validate DKIM
2. Match cancellation claim
3. Generate private proof
4. Verify proof
5. Create Midnight claim
6. Submit transaction
```

No mostrar spinner sin contexto.

### Screen 6 — Result

```text
CLAIM VERIFIED
```

Mostrar transaction/receipt.

### Screen 7 — Disclosure

```text
What was revealed?
What stayed private?
```

### Screen 8 — Replay

Button:

```text
Try to claim again
```

Resultado:

```text
REJECTED
This email claim was already used.
```

## 34.2 Estado

Usar una state machine.

Ejemplo:

```text
idle
wallet
file-selected
validating
proving
proof-ready
attesting
submitting
confirmed
rejected
error
```

No usar diez booleans.

## 34.3 Error handling

Errors simples:

```text
This email does not match the claim.
The DKIM signature is not valid.
The proof could not be generated.
The claim was already used.
The attestor is unavailable.
Midnight rejected the transaction.
```

## 34.4 Local privacy

No enviar raw email en:

- analytics;
- logs;
- Sentry;
- server actions;
- browser console.

## 34.5 Browser worker

Si proof generation bloquea UI:

- usar SDK worker;
- o dejar progress animation;
- no reescribir prover.

## 34.6 Criterio de salida

Un usuario nuevo completa el flow sin explicación.

E2E browser pasa.

Commit:

```text
feat(web): complete private email claim flow
```

---

# 35. Gate 9 — Negative demo cases

**Objetivo:** mostrar seguridad, no sólo happy path.

## 35.1 Replay

Mismo proof.

Resultado:

```text
ALREADY CLAIMED
```

## 35.2 Tampered email

Modificar una palabra.

Resultado:

```text
EMAIL AUTHENTICITY FAILED
```

## 35.3 Wrong sender

Email de otro dominio.

Resultado:

```text
UNSUPPORTED SENDER
```

## 35.4 Wrong claim

Email válido sin cancellation.

Resultado:

```text
CANCELLATION NOT PROVEN
```

## 35.5 Wrong wallet

Attestation bound a otra wallet.

Resultado:

```text
CLAIM NOT ISSUED FOR THIS ACCOUNT
```

## 35.6 Criterio de salida

Al menos dos negative paths funcionan en UI.

---

# 36. Gate 10 — Demo physical layer

**Estado:** P1.

No empezar antes del core.

## 36.1 Opción A — Thermal printer

Al confirmar:

```text
MAILPROOF CLAIM RECEIPT
Flight cancellation verified
Full email private
Claim ID: ...
```

## 36.2 Opción B — Servo gate

Un pequeño gate de aeropuerto se abre.

## 36.3 Opción C — Voucher dispenser

Una caja libera un voucher.

## 36.4 Interface

No conectar hardware directo a blockchain.

Usar un local demo listener.

El listener reacciona al estado confirmado.

## 36.5 Fallback

Si hardware falla, demo sigue.

El hardware nunca debe ser un single point of failure.

---

# 37. Gate 11 — Public network

**Estado:** opcional.

Local devnet primero.

## 37.1 Preview

Si todo funciona:

```bash
npm run setup -- --network preview
```

Obtener tokens.

Deploy.

Guardar contract address.

## 37.2 No bloquear submission

Si preview falla, usar local devnet.

Tener video.

## 37.3 Criterio de salida

No existe.

Public deployment es bonus.

---

# 38. Gate 12 — QA final

## 38.1 Run all

```bash
npm test
npm run test:e2e
npm run build
npm run lint
npm run typecheck
```

Ajustar scripts reales.

## 38.2 Demo reset

Crear:

```bash
npm run demo:reset
```

Debe:

- clear app state;
- deploy/reset contract;
- load wallet;
- ensure attestor health;
- verify proof fixture;
- verify hardware optional.

## 38.3 Repetición

Ejecutar demo cinco veces.

Registrar fallos.

## 38.4 Backup

Preparar:

- proof fixture;
- signed claim fixture;
- video;
- screenshots;
- local devnet;
- printed QR;
- second laptop.

## 38.5 Criterio de salida

Cinco demos seguidas.

No pasos improvisados.

---

# 39. Lista de tareas para el agente

El agente debe ejecutar en orden.

## Foundation

- [ ] M001 Leer documento completo.
- [ ] M002 Crear `docs/BUILD_LOG.md`.
- [ ] M003 Crear `docs/DECISIONS.md`.
- [ ] M004 Registrar versiones.
- [ ] M005 Confirmar mentor decisions.
- [ ] M006 Crear repo público.
- [ ] M007 Agregar Apache-2.0.
- [ ] M008 Agregar label `midnightntwrk`.
- [ ] M009 Scaffold contract.
- [ ] M010 Run local devnet.
- [ ] M011 Compile.
- [ ] M012 Run e2e.
- [ ] M013 Commit gate 1.

## Contract

- [ ] M020 Definir claim schema.
- [ ] M021 Definir campaign constant.
- [ ] M022 Definir attestor key.
- [ ] M023 Implementar signature verify spike.
- [ ] M024 Implementar nullifier set.
- [ ] M025 Implementar redeem.
- [ ] M026 Test valid.
- [ ] M027 Test invalid signature.
- [ ] M028 Test replay.
- [ ] M029 Test wrong context.
- [ ] M030 Commit contract.

## Email

- [ ] M040 Crear email de demo.
- [ ] M041 Descargar `.eml`.
- [ ] M042 Inspeccionar DKIM.
- [ ] M043 Identificar unique claim field.
- [ ] M044 Crear/select blueprint.
- [ ] M045 Test valid email.
- [ ] M046 Test tampered email.
- [ ] M047 Pin slug/version.
- [ ] M048 Install SDK exact.
- [ ] M049 Create CLI prover.
- [ ] M050 Generate proof.
- [ ] M051 Verify proof.
- [ ] M052 Measure time.
- [ ] M053 Create backup proof.

## Attestor

- [ ] M060 Create service.
- [ ] M061 Add health.
- [ ] M062 Add request schema.
- [ ] M063 Add blueprint allowlist.
- [ ] M064 Verify proof server-side.
- [ ] M065 Validate outputs.
- [ ] M066 Derive context nullifier.
- [ ] M067 Build canonical claim.
- [ ] M068 Sign claim.
- [ ] M069 Unit tests.
- [ ] M070 Privacy log test.
- [ ] M071 Commit attestor.

## Integration

- [ ] M080 Create CLI e2e.
- [ ] M081 Get attestation.
- [ ] M082 Redeem on contract.
- [ ] M083 Verify state.
- [ ] M084 Replay.
- [ ] M085 Repeat three times.
- [ ] M086 Commit e2e.

## Web

- [ ] M090 Add wallet connect.
- [ ] M091 Add `.eml` drop.
- [ ] M092 Add local validation.
- [ ] M093 Add local proving.
- [ ] M094 Add attestor call.
- [ ] M095 Add Midnight submit.
- [ ] M096 Add confirmation.
- [ ] M097 Add privacy panel.
- [ ] M098 Add replay demo.
- [ ] M099 Add tamper demo.
- [ ] M100 Add error handling.
- [ ] M101 Build.
- [ ] M102 Commit UI.

## Finish

- [ ] M110 README.
- [ ] M111 Architecture.
- [ ] M112 Threat model.
- [ ] M113 Tests.
- [ ] M114 Demo script.
- [ ] M115 Pitch deck.
- [ ] M116 Video.
- [ ] M117 Public links.
- [ ] M118 Run submission checklist.
- [ ] M119 Freeze features.
- [ ] M120 Submit.

