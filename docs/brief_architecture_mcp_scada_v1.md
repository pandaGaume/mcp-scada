# Architecture MCP SCADA v1

## Contrat des providers destination cache securite du Broker et ouverture au harness

Date : 30 septembre 2026

## Decision proposee

SCADA v1 doit devenir un contrat obligatoire pour les providers industriels.

Le MCP Broker reste l'autorite de securite et reutilise son moteur existant de regles et de policies. `mcp-scada` ne doit pas introduire un second moteur de policy. Il normalise les ressources, verifie les capabilities, enrichit chaque demande avec le contexte industriel disponible, appelle le moteur de policy du Broker avant toute operation sensible et conserve la decision dans l'audit.

Le futur harness n'est pas encore specifie. Ce brief ne suppose donc ni son architecture interne, ni son cycle de raisonnement, ni son modele de planification. SCADA v1 doit seulement fournir une interface stable qu'un client MCP actuel ou un futur harness pourra utiliser.

## 1. Separation des contrats

L'architecture repose sur quatre responsabilites distinctes.

| Composant | Responsabilite | Ne doit pas contenir |
|---|---|---|
| UNS | Identite canonique et durable des ressources | Details de session, cache ou transport |
| SCADA v1 | Abstraction fonctionnelle pour `browse`, `read`, `write`, `invoke` et `subscribe` | Concepts propres a OPC UA, Modbus ou un autre protocole |
| Provider | Binding entre SCADA v1 et le protocole industriel | Policy globale de l'acteur ou du site |
| MCP Broker | Authentification, autorisation, policies, contraintes, approbations et audit | Conversion propre aux protocoles industriels |

L'invariant principal reste :

```text
UNS          = identite
SCADA v1     = abstraction fonctionnelle
Provider     = binding protocolaire
MCP Broker   = autorite de policy
```

## 2. Contrat obligatoire des providers

Chaque provider doit implementer la meme interface SCADA v1 et publier precisement ses capabilities.

```csharp
public interface IScadaProvider
{
    string Id { get; }

    Task<ScadaCapabilities> GetCapabilitiesAsync();

    Task<BrowseResult> BrowseAsync(
        BrowseRequest request,
        CancellationToken cancellationToken);

    Task<ReadResult> ReadAsync(
        ReadRequest request,
        CancellationToken cancellationToken);

    Task<WriteResult> WriteAsync(
        WriteRequest request,
        CancellationToken cancellationToken);

    Task<InvokeResult> InvokeAsync(
        InvokeRequest request,
        CancellationToken cancellationToken);

    Task<SubscriptionHandle> SubscribeAsync(
        SubscribeRequest request,
        CancellationToken cancellationToken);

    Task UnsubscribeAsync(
        string subscriptionId,
        CancellationToken cancellationToken);
}
```

### 2.1 Capabilities minimales

Le provider doit publier :

- la version de `scada.v1` implementee ;
- les operations supportees ;
- les destinations qu'il sait reellement distinguer ;
- les modeles de consistency disponibles ;
- sa politique de cache ;
- les limites de lot, de debit et de concurrence ;
- les schemas des valeurs et arguments ;
- les modes d'abonnement disponibles ;
- les mecanismes de securite du protocole ;
- les metadonnees natives conservables dans les resultats et l'audit.

Exemple :

```json
{
  "interface": "scada.v1",
  "provider": "opcua-line1",
  "capabilities": {
    "read": {
      "destinations": ["provider", "source"],
      "consistency": ["cached", "fresh", "max-age", "source"]
    },
    "write": {
      "supported": true,
      "destinations": ["source"]
    },
    "invoke": {
      "supported": true
    },
    "subscribe": {
      "supported": true,
      "mode": "native"
    }
  }
}
```

Une capability decrit ce que le provider sait faire. Elle ne donne jamais l'autorisation de le faire.

## 3. Destination et politique de cache

Un `read()` sans destination ni exigence de fraicheur est ambigu. Une valeur peut exister simultanement dans plusieurs caches :

```text
Client MCP
    |
    v
MCP Broker cache
    |
    v
Provider cache
    |
    v
Gateway ou controller
    |
    v
Device ou source declaree
```

La signature logique devient :

```text
read(resource, destination, consistency)
```

Le retour contient :

```text
value + quality + timestamps + provenance
```

### 3.1 Destinations logiques

| Destination | Semantique |
|---|---|
| `local` | Cache du MCP Broker uniquement. Aucun acces aval. |
| `provider` | Cache gere par le provider de protocole. |
| `gateway` | Valeur exposee par une passerelle industrielle. |
| `controller` | Valeur au niveau PLC, RTU ou controleur, si cette distinction existe. |
| `device` | Acces au device ou au capteur uniquement si le provider peut le garantir. |
| `source` | Source autoritative selon la semantique declaree par le provider. |

`source` est volontairement abstrait.

Pour OPC UA :

```text
source = OPC UA Server
```

Un client OPC UA ne sait generalement pas si le serveur a relu physiquement un PLC ou un capteur. Le provider OPC UA ne doit donc pas promettre `device` sans information supplementaire explicite.

Pour Modbus direct :

```text
source = device
```

Pour Modbus derriere une gateway, le provider doit declarer si la lecture interroge le device aval ou retourne le cache de la gateway. S'il ne peut pas le determiner, il indique `gateway` et ne pretend pas avoir lu `device`.

### 3.2 Consistency

SCADA v1 doit au minimum pouvoir exprimer :

| Valeur | Semantique |
|---|---|
| `cached` | Retourne une valeur deja disponible sans communication aval. |
| `fresh` | Retourne une valeur conforme a la fenetre de fraicheur du provider. |
| `max-age` | Accepte le cache seulement si son age ne depasse pas `maxAgeMs`. |
| `source` | Force un acces a la source declaree lorsque le provider le supporte. |

Exemple :

```json
{
  "ids": [
    "uns://production/site1/line1/motor01/speed"
  ],
  "destination": "source",
  "consistency": {
    "maxAgeMs": 250
  }
}
```

### 3.3 Provenance du resultat

Le resultat doit indiquer ce qui s'est effectivement passe :

```json
{
  "id": "uns://production/site1/line1/motor01/speed",
  "value": 1450,
  "quality": "good",
  "sourceTimestamp": "2026-09-30T12:31:14.011Z",
  "receivedTimestamp": "2026-09-30T12:31:14.035Z",
  "provenance": {
    "provider": "opcua-line1",
    "level": "provider",
    "cached": true,
    "cacheMode": "subscription",
    "ageMs": 184
  }
}
```

Si le vrai `sourceTimestamp` est inconnu, il reste `null`. Le provider ne doit pas le synthetiser.

### 3.4 Regles obligatoires de cache

- Un provider ne publie que les niveaux qu'il sait distinguer.
- Une destination non supportee retourne `unsupported_destination`.
- Aucun downgrade silencieux n'est autorise.
- Un fallback n'est permis que si le client fournit explicitement une liste ordonnee de destinations.
- Le provider expose son mode de cache : `none`, `read-through`, `polling`, `subscription`, `push` ou `hybrid`.
- Une lecture forcee vers la source peut etre soumise aux limites de debit et de concurrence du Broker.
- Une valeur dynamique ne doit pas etre servie silencieusement depuis un cache si la requete exige la source.

## 4. Reutilisation des policies du MCP Broker

Le MCP Broker propose deja des regles et des policies. Ce mecanisme doit devenir le point d'enforcement commun pour SCADA.

`mcp-scada` ne doit pas recreer :

- un second langage de policy ;
- un second stockage de regles ;
- un second cycle de publication et de versionnement ;
- une seconde logique d'approbation ;
- une seconde autorite d'audit.

SCADA apporte au Broker les attributs industriels necessaires a l'evaluation : ressource UNS, operation, destination, valeur demandee, effet connu, provider, contexte operationnel disponible et identifiant de correlation.

### 4.1 Repartition des responsabilites

| Composant | Responsabilite |
|---|---|
| Client MCP | Emet une requete SCADA et fournit les attributs requis par le contrat du Broker. |
| `mcp-scada` | Resout l'UNS, verifie la capability, normalise la demande et construit le contexte de policy. |
| MCP Broker | Authentifie l'acteur, evalue ses policies et retourne une decision avec ses contraintes. |
| Provider | Applique les contraintes recues et execute le binding protocolaire. |
| Systeme industriel | Applique ses controles natifs, par exemple les droits OPC UA ou les protections du PLC. |

### 4.2 Contexte de policy

L'exemple suivant est illustratif. Les noms exacts doivent suivre le modele deja utilise par le MCP Broker.

```json
{
  "actor": {
    "id": "mcp-client-17",
    "type": "mcp-client",
    "roles": ["maintenance-observer"]
  },
  "operation": "write",
  "resource": "uns://production/site1/line1/motor01/speed-setpoint",
  "destination": "source",
  "requestedValue": 2400,
  "effect": "physical-action",
  "provider": "opcua-line1",
  "plantContext": {
    "mode": "maintenance",
    "site": "testbench"
  },
  "requestContext": {
    "correlationId": "req-7f31"
  }
}
```

Un adaptateur `PolicyContextMapper` peut traduire le contexte SCADA vers le modele de policy du Broker. Il ne constitue pas un nouveau moteur de regles.

### 4.3 Decisions attendues

| Decision | Effet |
|---|---|
| `allow` | Execution autorisee dans les limites retournees. |
| `deny` | Aucun appel provider. Le motif est conserve dans l'audit. |
| `require-approval` | Execution suspendue jusqu'a une approbation valide. |
| `allow-with-constraints` | Execution limitee par une plage, une destination, une duree, un debit ou des preconditions. |

### 4.4 Ordre de confiance

Une declaration provider ou une metadata protocolaire ne peut jamais elargir une autorisation donnee par le Broker.

```text
Policies du MCP Broker
    > configuration SCADA approuvee
    > declaration de capability du provider
    > metadata du protocole ou du device
```

## 5. Modele de cybersecurite

La separation fondamentale est la suivante :

```text
Le MCP Broker securise l'acteur et l'operation demandee.
Le provider securise le protocole et ses credentials.
Le systeme industriel conserve ses protections natives.
```

Ces controles sont cumulatifs.

| Controle | MCP Broker et SCADA | Provider et protocole |
|---|---|---|
| Identite | Acteur MCP, roles et session | Compte OPC UA, certificat ou identite de gateway |
| Autorisation | UNS, operation, destination, valeur et contexte | Droits sur NodeId, registre ou methode |
| Contraintes | Plage, mode, horaire, debit, duree et approbation | Type, acces, StatusCode et limites natives |
| Secrets | References aux credentials sans exposition au client | Stockage et usage du secret pour la connexion |
| Audit | Demande, policy, decision et resultat de bout en bout | Resultat natif, erreurs et etat de session |

### 5.1 Classes d'operations

| Classe | Exemples | Politique typique |
|---|---|---|
| `observe` | Browse et lecture depuis cache local | Autorisation possible avec filtrage des ressources |
| `acquire` | Lecture forcee vers gateway ou source | Rate limit, timeout et quota de concurrence |
| `control` | Ecriture de consigne ou de propriete | Deny par defaut, plage et contexte obligatoires |
| `execute` | Start, stop, reset ou sequence | Autorisation explicite ou approbation selon l'effet |
| `admin` | Provider, certificats, mappings et policies | Hors de la surface SCADA operationnelle normale |

Ces classes sont des attributs de policy. Elles ne prejugent pas du fonctionnement d'un futur harness.

### 5.2 Discoverability et executabilite

Un client MCP peut connaitre l'existence d'une action sans etre autorise a l'executer.

`browse` et les metadata peuvent exposer une ressource, son schema et son effet. La policy du Broker reste seule competente pour autoriser `write` ou `invoke`.

### 5.3 Execution en deux phases

Un mecanisme `prepare` puis `commit` peut etre ajoute pour les operations sensibles si le modele de securite le requiert. Il s'agit d'une capability optionnelle de SCADA et du Broker, pas d'une hypothese sur le harness.

`prepare` peut figer :

- la cible normalisee ;
- les arguments ;
- la decision de policy ;
- les contraintes ;
- l'expiration ;
- l'etat d'approbation.

`commit` doit revalider les informations volatiles avant l'appel provider.

## 6. Audit et tracabilite

L'audit SCADA est obligatoire pour :

- `write` ;
- `invoke` ;
- approbation ou refus ;
- override de policy ;
- modification de configuration ou de securite.

Il complete l'audit OPC UA ou celui de la gateway, car il connait l'acteur MCP, la ressource UNS, la policy appliquee et la decision du Broker.

```json
{
  "correlationId": "req-7f31",
  "actor": "mcp-client-17",
  "operation": "write",
  "resource": "uns://production/site1/line1/motor01/speed-setpoint",
  "destination": "source",
  "requested": 1200,
  "provider": "opcua-line1",
  "policy": "industrial-control-v2",
  "decision": "allow",
  "constraints": {
    "maxValue": 1500
  },
  "result": "success",
  "nativeStatus": "Good",
  "timestamp": "2026-09-30T12:42:17Z"
}
```

Les mots de passe, cles privees, tokens et certificats complets ne doivent jamais apparaitre dans les reponses MCP ou les logs.

## 7. Flux canonique d'une operation

1. Le client MCP emet une requete portant sur une ressource UNS.
2. `mcp-scada` resout le binding et recupere les capabilities du provider.
3. `mcp-scada` valide la forme, le type, la destination et la consistency demandes.
4. `mcp-scada` construit le contexte industriel de policy.
5. Le MCP Broker evalue ses regles et policies existantes.
6. En cas de `deny`, aucun appel provider n'est emis.
7. En cas de `require-approval`, l'operation reste suspendue.
8. En cas de `allow`, `mcp-scada` applique les contraintes et appelle le provider.
9. Le provider execute avec la securite native du protocole.
10. `mcp-scada` normalise le resultat, ajoute la provenance et complete l'audit.

## 8. Erreurs normalisees

| Erreur | Comportement attendu |
|---|---|
| `unsupported_capability` | Refus avant execution. La capability manquante est retournee. |
| `unsupported_destination` | Refus sans fallback implicite. |
| `policy_denied` | Aucun appel provider. Motif stable et identifiant d'audit. |
| `approval_required` | Operation suspendue jusqu'a approbation ou expiration. |
| `constraint_violation` | Refus avant provider avec la contrainte violee. |
| `native_protocol_error` | Erreur SCADA normalisee avec detail natif conserve. |
| `provenance_unknown` | Provenance explicitement inconnue. Aucune origine n'est inventee. |

## 9. Ouverture a un harness futur

Le harness n'etant pas specifie, SCADA v1 ne doit definir ni :

- son modele de memoire ;
- sa representation des plans ;
- son cycle de raisonnement ;
- son mecanisme de selection des tools ;
- son interface d'approbation ;
- son niveau d'autonomie ;
- sa strategie de verification.

SCADA v1 doit seulement fournir les elements stables suivants :

| Garantie SCADA v1 | Utilite future possible |
|---|---|
| Identites UNS stables | Referencer une meme ressource entre plusieurs appels |
| Capabilities explicites | Connaitre les operations disponibles |
| Destination et consistency | Demander une origine et une fraicheur precises |
| Provenance et qualite | Evaluer la confiance dans une valeur |
| Decision de policy du Broker | Distinguer disponibilite technique et autorisation |
| Correlation et audit | Relier demande, decision, execution et resultat |

Un futur harness pourra consommer ce contrat, mais sa specification doit faire l'objet d'un document separe.

## 10. Decisions d'implementation

| Decision | Statut propose |
|---|---|
| Le MCP Broker est le moteur de policy unique | Invariant d'architecture a confirmer |
| SCADA v1 impose une interface provider | Obligatoire |
| Capabilities et `cachePolicy` sont declaratifs | Obligatoire et verifie a l'enregistrement |
| Une capability provider ne vaut pas autorisation | Obligatoire |
| `source` est defini par chaque provider | Obligatoire |
| Aucun fallback silencieux | Obligatoire |
| Audit de bout en bout | Obligatoire pour toute mutation et decision de policy |
| `prepare` et `commit` | Extension optionnelle a evaluer selon les operations sensibles |
| Architecture du harness | Hors perimetre de SCADA v1 |

## 11. Points a aligner avec le MCP Broker

- Modele actuel des sujets, roles, ressources et actions dans les policies.
- Representation des attributs SCADA et du contexte dynamique.
- Format des decisions, contraintes et approbations.
- Propagation du `correlationId` et d'un eventuel `operationId`.
- Garanties entre decision, execution et audit.
- Gestion des operations preparees si cette extension est retenue.
- Regles de redaction des valeurs sensibles.
- Policies applicables aux lectures forcees vers la source.

## 12. Plan de mise en oeuvre

### Phase 1

- Interface `IScadaProvider`.
- Capabilities.
- UNS binding.
- `browse`, `read` et `write`.
- Destination, consistency, `cachePolicy` et provenance.
- Tests de contrat communs pour OPC UA et Modbus.

### Phase 2

- Adaptateur vers le moteur de policy existant du MCP Broker.
- Classes d'operations et contraintes.
- Audit de bout en bout.
- Garantie qu'aucune mutation n'atteint un provider sans decision du Broker.

### Phase 3

- `invoke` et `subscribe`.
- Reconnexion et restauration des abonnements.
- Evenements et conditions.
- Evaluation de `prepare` et `commit` selon les besoins de securite.

### Hors perimetre

- Architecture interne du harness.
- Algorithme de raisonnement ou de planification.
- Modele d'autonomie.
- Interface utilisateur d'approbation.

## 13. Tests de conformite prioritaires

- Un provider ne peut pas enregistrer une destination qu'il ne sait pas distinguer.
- Un `read cached` ne produit aucun trafic aval.
- Un `read source` respecte les limites imposees par le Broker.
- Un `deny` ne provoque aucun appel provider.
- Une contrainte de valeur est appliquee juste avant l'execution.
- L'audit relie la demande, la decision, l'execution et le resultat natif.
- Une reconnexion provider ne modifie pas les identites UNS.
- Un provider ne peut pas s'auto-autoriser par ses propres metadata.

## 14. Invariant final

Le client MCP emet une requete. Le MCP Broker decide si elle est autorisee selon ses regles et policies. `mcp-scada` garantit le contrat industriel, la normalisation et la tracabilite. Le provider realise le binding et applique la securite du protocole. Le systeme industriel conserve ses protections natives.

Le futur harness pourra etre un client de cette architecture, mais rien dans SCADA v1 ne doit presumer de sa conception tant que sa specification n'existe pas.
