# MailProof
## Convertí emails reales en pruebas privadas para aplicaciones de Midnight

**Documento maestro de producto, arquitectura, implementación, QA, demo y handoff para agentes**  
**Hack Buenos Aires 2026**  
**Fecha de referencia:** 7 de agosto de 2026  
**Estado:** plan de ejecución v1.0  
**Idioma:** español simple y técnico  
**Licencia recomendada para el repositorio:** Apache-2.0

> **MailProof permite demostrar una afirmación contenida en un email auténtico sin entregar el email completo.**

> **La empresa que envía el email no tiene que integrar Midnight. La aplicación que consume la prueba sí.**

> **Turn emails into private proofs.**

---


## Mapa del documento

```text
Parte I    Producto y arquitectura             Secciones 0–23
Parte II   Implementación paso a paso           Secciones 24–39
Parte III  Tests, seguridad y fallbacks         Secciones 40–49
Parte IV   Demo, pitch, negocio y entrega       Secciones 50–60
Parte V    Handoff operativo para el agente     Secciones 61–80
```

Decisión técnica central:

> **ZK Email verifica el email. Un attestor verifica ese proof y firma un claim canónico. Compact verifica la firma, el contexto y el nullifier.**

Esta arquitectura es el MVP recomendado.

El documento también define la ruta futura para reducir o eliminar la confianza en el attestor.

---

# 0. Cómo usar este documento

Este archivo tiene dos lectores.

El primer lector es el equipo humano.

El segundo lector es el agente que va a implementar el proyecto.

El agente debe leer el documento completo antes de escribir código.

El agente no debe empezar por el frontend.

El agente debe pasar cada gate en orden.

Cada gate tiene una condición de salida.

El agente no debe declarar un gate como completo si no ejecutó la verificación indicada.

El agente debe registrar:

- los comandos ejecutados;
- las versiones instaladas;
- los errores;
- las decisiones;
- los cambios de alcance;
- los resultados de tests;
- el tiempo de proof generation;
- las limitaciones conocidas.

El agente debe mantener estos archivos durante el trabajo:

```text
docs/BUILD_LOG.md
docs/DECISIONS.md
docs/KNOWN_LIMITATIONS.md
docs/DEMO_RUNBOOK.md
```

El agente debe hacer commits pequeños después de cada gate estable.

El agente no debe agregar nuevas features si el contrato Compact no compila.

---

