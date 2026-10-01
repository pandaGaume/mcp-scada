# Validation du brief "Architecture MCP SCADA v1"

Date : 30 septembre 2026
Objet : relecture du brief contre le code existant de `mcp-broker` 1.4.0, `mcp-core` 1.3.0 et `mcp-modbus` (commit `31e7b88`), puis implémentation de la phase 1 et d'une partie de la phase 2, testée sur un slot Modbus réel.

## Verdict

**Le brief est validé sur le fond.** La séparation UNS / SCADA v1 / provider / MCP Broker est juste. Elle se projette proprement sur le code existant. En particulier, les chemins de ressources ISA-95 du broker acceptent l'UNS tel quel (`uns://a/b/c` devient `/a/b/c`), ce qui permet au moteur de policy existant de gouverner les ressources SCADA sans second modèle de ressources.

Trois hypothèses du brief ne correspondent pas au broker actuel. Elles sont à corriger dans le document avant de le considérer comme contractuel :

| # | Hypothèse du brief | Réalité du broker 1.4.0 | Gravité |
|---|---|---|---|
| A1 | Le Broker "authentifie l'acteur" et `mcp-scada` lui transmet le contexte | Le broker autorise la trame du client puis la relaie au slot **sans le principal**. Un `mcp-scada` publié comme slot ne sait pas qui appelle. | Bloquant pour un déploiement multi-utilisateur |
| A2 | Décisions `allow`, `deny`, `require-approval`, `allow-with-constraints` (§4.3) | `IPolicyEngine.authorize()` renvoie `{ allowed, reason, matchedPolicies }`. Binaire. Pas d'approbation, pas de contrainte. | Bloquant pour `control` et `execute` |
| A3 | Le contexte de policy (§4.2) est évalué : destination, valeur, effet, `plantContext` | Le moteur n'évalue que `subject`, `capability` et `resource` (plus `provider` et `tool` pour l'audit). | Majeur : ces attributs sont audités, pas évalués |

## Constats détaillés

### 1. Langage de l'interface

Le brief donne `IScadaProvider` en C#. Tout l'écosystème actif est TypeScript : le broker (`node/`), `mcp-core`, les consoles. Le dossier `mcp-broker/dotnet` est marqué "planned". L'implémentation est donc en TypeScript ; `CancellationToken` devient `AbortSignal`, `Task<T>` devient `Promise<T>`. Le contrat reste transposable tel quel pour un futur port .NET.

**Correction proposée :** présenter l'interface en TypeScript et garder le C# en annexe.

### 2. Réutilisation du moteur de policy (A2, A3)

Ce qui est réutilisable directement, et réutilisé :

- `compileAuthorizationPolicy(config)` et `ConfigPolicyEngine` sont exportés par `@cyanmycelium/mcp-broker`. `mcp-scada` compile **la même section `auth`** que le `config.json` du broker. Aucun langage, stockage ni cycle de publication supplémentaire.
- Les rôles, assignations par sous-arbre (`/production/site1/**`) et `denies` explicites s'appliquent aux ressources UNS sans adaptation.
- Les classes d'opérations du §5.1 deviennent des **capabilities** du broker : `scada.observe`, `scada.acquire`, `scada.control`, `scada.execute`. C'est exactement le rôle que le broker donne aux capabilities ("what may they do").

Ce qui manque :

- **A2.** Le broker ne sait produire ni approbation ni contrainte. Le contrat SCADA porte les quatre décisions, et `ScadaService` les applique toutes, mais l'adaptateur `BrokerPolicyGate` ne produit que `allow` et `deny`. Pour obtenir `require-approval` et `allow-with-constraints` sans second moteur, il faut étendre `IAuthorizationDecision` côté broker (par exemple des *obligations* attachées à une assignation). C'est une évolution du broker, pas de `mcp-scada`.
- **A3.** Destination, valeur demandée, effet et contexte d'exploitation ne sont pas évalués par le moteur. Ils sont construits, transmis à `IScadaPolicyGate` et écrits dans l'audit. La destination est néanmoins prise en compte indirectement : une lecture qui peut descendre (`device`, `source`...) est classée `acquire`, une lecture du cache `local` est `observe`.

**Contraintes de valeur en attendant A2.** Les plages sont portées par la "configuration SCADA approuvée" (niveau 2 de l'ordre de confiance du §4.4), par ressource UNS. Elles ne font que restreindre, et s'intersectent avec les contraintes qu'un futur broker renverrait. Attention : cette configuration doit rester une donnée d'ingénierie (limites procédé d'une consigne), jamais une règle par acteur ou par rôle, sinon elle devient le second stockage de règles que le §4 interdit.

**Corrections proposées :** au §4.3, indiquer que `require-approval` et `allow-with-constraints` dépendent d'une évolution du broker ; au §4.2, distinguer les attributs évalués (subject, capability, resource) des attributs audités.

### 3. Identité de l'acteur (A1)

Le broker authentifie le client, évalue ses propres règles au niveau du slot, puis relaie la requête. Le provider reçoit une trame JSON-RPC sans identité. Deux voies :

1. le broker propage les sujets vérifiés dans `params._meta` vers les providers qu'il juge de confiance (loopback ou provider authentifié) ;
2. `mcp-scada` tourne dans le processus du broker et reçoit le principal par un hook.

La voie 1 est la plus simple et reste compatible avec un `mcp-scada` hors processus. En attendant, le slot `scada` agit sous **un acteur de service configuré** (`ActorResolver`). C'est acceptable pour un banc ou un site mono-opérateur, pas au-delà.

### 4. Destination `local`

Le brief définit `local` comme "cache du MCP Broker". Le broker n'a aucun cache de valeurs. `local` est donc implémenté dans `mcp-scada`, qui se situe dans le tiers broker. La garantie est tenue par construction : ce cache n'est alimenté que par des lectures réellement descendues et ne descend jamais lui-même.

**Correction proposée :** "cache du tiers Broker, tenu par `mcp-scada`".

### 5. Niveau de `source` et destinations

Le §3.1 écrit `source = OPC UA Server`, mais "server" n'est pas une destination. L'implémentation sépare les deux notions :

- `Destination` : `local`, `provider`, `gateway`, `controller`, `device`, `source` ;
- `SourceLevel`, déclaré par chaque provider : `gateway`, `controller`, `device` ou `server`.

La validation à l'enregistrement (§10, "vérifié à l'enregistrement") refuse une déclaration incohérente : `local` déclaré par un provider, `provider` ou `cached` sans cache, ou un niveau physique autre que la source déclarée (un provider dont la source est `gateway` ne peut pas annoncer `device`).

### 6. Limites de débit

Le §13 demande qu'un `read source` respecte "les limites imposées par le Broker". Le broker n'a pas de limite de débit dans ses policies. `mcp-scada` applique donc la plus stricte des limites de déploiement et de celles déclarées par le provider (concurrence et débit par seconde, par provider). Un dépassement est **refusé** (`rate_limited`), jamais mis en file : une lecture forcée mise en attente rendrait une valeur plus vieille que demandé, soit un downgrade silencieux.

### 7. Audit

Le broker écrit ses événements d'autorisation par `writeAuthorizationAuditEvent`, mais ne l'exporte pas depuis la racine du paquet. `BrokerPolicyGate` reproduit le même format et le même flux (`[broker] authorization {...}` sur stderr) : les refus SCADA arrivent dans l'audit du broker, pas dans une seconde autorité. L'audit SCADA le complète avec deux enregistrements par opération, liés par `correlationId` : `decision` (écrit avant tout appel provider) et `result` (avec le statut natif). Les valeurs auditées passent par une rédaction des clés sensibles.

**Demande au broker :** exporter `makeAuthorizationAuditEvent` et `writeAuthorizationAuditEvent`.

### 8. Précisions de contrat ajoutées

- Une lecture sans destination est refusée (`invalid_request`). La consistency a une valeur par défaut dérivée de la destination : `local` en `cached`, `provider` en `fresh`, tout niveau aval en `source`.
- Une écriture a exactement une destination. **Aucun fallback en écriture**, même explicite.
- Un fallback de lecture n'est tenté que sur une liste ordonnée fournie par le client ; l'erreur finale contient la liste des tentatives.
- `mcp-scada` vérifie la provenance renvoyée par le provider : valeur en cache pour une lecture `source`, valeur plus vieille que `maxAgeMs`, ou provenance absente sont refusées.
- Une capability non supportée est refusée **avant** d'interroger la policy.
- Codes d'erreur ajoutés à la liste du §8 : `unsupported_consistency`, `unknown_resource`, `invalid_request`, `rate_limited`, `cache_miss`, `provider_unavailable`.

### 9. Ce que le slot Modbus permet réellement aujourd'hui

`McpModbusService` publie `modbus.read`, `modbus.batch_read`, `modbus.device_test`, `modbus.endpoint_test` et l'inventaire `modbus://gateway/inventory`. D'où la déclaration du `ModbusScadaProvider` :

| Élément | Valeur | Raison |
|---|---|---|
| `source` | `device` (ou `gateway` si configuré) | Modbus TCP direct : la lecture est une transaction avec l'esclave |
| `cachePolicy.mode` | `none` | Chaque lecture est live ; le cache et la qualité sont prévus côté scheduler Modbus |
| `read.destinations` | `device`, `source` | `provider` refusé faute de cache |
| `read.consistency` | `fresh`, `max-age`, `source` | `cached` refusé faute de cache |
| `sourceTimestamp` | toujours `null` | Modbus ne transporte pas d'horodatage, il n'est pas synthétisé |
| `write`, `invoke`, `subscribe` | non supportés | `modbus.write` et les abonnements sont planifiés côté `mcp-modbus` |
| UNS | `<racine>/<device>/<binding>` | Clés de catalogue stables : un redémarrage ou un renommage de slot ne change pas l'identité |

Plusieurs bindings d'un même device sont lus en un seul `modbus.batch_read`.

## Ce qui est implémenté

| Phase du brief | Élément | État |
|---|---|---|
| 1 | Interface `IScadaProvider` | Fait (`src/contract`) |
| 1 | Capabilities et validation à l'enregistrement | Fait |
| 1 | Binding UNS, racines par provider, refus des chevauchements | Fait (`src/uns`) |
| 1 | `browse`, `read`, `write` | Fait ; `write` testé sur provider simulé, refusé proprement sur Modbus |
| 1 | Destination, consistency, `cachePolicy`, provenance | Fait |
| 1 | Tests de contrat communs OPC UA / Modbus | Tests communs sur provider simulé + tests live Modbus ; OPC UA à venir |
| 2 | Adaptateur vers le moteur de policy du broker | Fait (`BrokerPolicyGate`), limité par A2 et A3 |
| 2 | Classes d'opérations et contraintes | Fait |
| 2 | Audit de bout en bout | Fait |
| 2 | Aucune mutation sans décision du broker | Fait et testé |
| 3 | `invoke` | Chemin de policy et d'audit fait ; aucun provider réel ne le supporte encore |
| 3 | `subscribe`, reconnexion d'abonnements, `prepare`/`commit` | Non commencé |

## Couverture des tests de conformité du §13

| Test du brief | Couvert par |
|---|---|
| Un provider ne peut pas enregistrer une destination indistinguable | `conformance.test.ts` §13.1 |
| Un `read cached` ne produit aucun trafic aval | §13.2, et live : "serves `local`... with no Modbus traffic" |
| Un `read source` respecte les limites | §13.3 |
| Un `deny` ne provoque aucun appel provider | §13.4, et live : compteur d'appels au slot Modbus inchangé |
| Une contrainte de valeur est appliquée juste avant l'exécution | §13.5 |
| L'audit relie demande, décision, exécution et résultat natif | §13.6 |
| Une reconnexion provider ne modifie pas les identités UNS | live : le provider C++ est tué puis relancé |
| Un provider ne peut pas s'auto-autoriser par ses metadata | §13.8 |

## Points d'alignement avec le broker, par priorité

1. **A1** Propager les sujets vérifiés vers les providers de confiance.
2. **A2** Étendre `IAuthorizationDecision` avec des obligations (approbation, contraintes, expiration).
3. Exporter les fonctions d'audit d'autorisation.
4. Décider si les limites de débit relèvent de la policy du broker ou de la configuration de déploiement.
5. **A3** Décider si destination et effet deviennent des attributs évaluables, ou restent encodés dans la capability.
