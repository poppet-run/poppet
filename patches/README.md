# Dependency patches

`libsignal@6.0.0.patch` removes four console calls that print session objects,
including private ratchet keys. Baileys' logger cannot suppress these calls.
Session transitions and key handling are unchanged. The WhatsApp privacy test
exercises closure, reopening, and pruning through Baileys' installed dependency
in a subprocess and requires silent output. Reassess the patch when upgrading
Baileys or libsignal; remove it when upstream no longer logs private objects.
