# Évolution du MCP Broker : domaines partagés par sous-arbre UNS

Date : 2 octobre 2026
Base : `@cyanmycelium/mcp-broker` 1.6.0, `@cyanmycelium/mcp-broker-provider` 0.3.0
Origine : [évolution du broker pour SCADA v1](brief_evolution_mcp_broker_scada.md), dont ce brief prolonge la numérotation (E1 à E6) ; [historisation](https://github.com/pandaGaume/mcp-history/blob/main/docs/brief_history_slot.md) et [cache](https://github.com/pandaGaume/mcp-cache/blob/main/docs/brief_cache_slot.md) comme slots génériques

## Rappel : E1 à E6

Le premier brief a fait du broker le seul point de décision pour SCADA. Ses évolutions :

| # | Évolution | État |
|---|---|---|
| E1 | Déclaration d'autorisation par un provider (`broker/authorization/declare`) | livrée, broker 1.5.0 |
| E2 | Référence d'appelant transmise au provider (`_meta["io.cyanmycelium/caller"]`) | livrée, broker 1.5.0 et mcp-core 1.4.0 |
| E3 | API de décision `broker/authorize` | livrée, broker 1.5.0 |
| E4 | Décisions avec obligations (limites d'ingénierie, `allow-with-constraints`) | livrée, broker 1.5.0 et 1.6.0 |
| E5 | Audit unique tenu par le broker (`broker/audit/result`) | livrée, broker 1.5.0 |
| E6 | Conditions sur attributs | non faite, optionnelle |

Ce brief ajoute **E7** (un domaine, plusieurs propriétaires, un sous-arbre UNS chacun) et **E8** (retrait d'une déclaration).

## Décision proposée

Un domaine est un **vocabulaire de capabilities** (`history.*`), pas un lieu. Le lieu, c'est le chemin de ressource, c'est-à-dire l'id UNS. Aujourd'hui, un domaine n'a qu'un propriétaire pour tout le broker. Il en aura **un par sous-arbre UNS**, les sous-arbres de ses propriétaires étant disjoints.

```text
                    domaine "history" : un vocabulaire, history.read / record / admin
                    ┌────────────────────────────┬────────────────────────────┐
   propriétaire     │ mcp-history-site1          │ mcp-history-site2          │
   sous-arbre       │ /production/site1/**       │ /production/site2/**       │
   slot             │ history-site1              │ history-site2              │
                    └────────────────────────────┴────────────────────────────┘
   rôle "historian" : capabilities history.*, une seule définition
   assignation      : group:historians-site1 → historian sur /production/site1/**
```

Chaque site a son historien, ou son cache, en local, près des équipements et sans dépendre d'un serveur central. Les rôles restent uniques ; les assignations suivent l'UNS, comme pour SCADA.

## Pourquoi pas un domaine par site

Le broker exige qu'une capability commence par son domaine (E1). Avec `history-site1`, `history-site2`, etc. :

- les capabilities deviennent `history-site1.read`, `history-site2.read`… ;
- chaque rôle doit les lister toutes : le rôle « lecteur d'historique » n'existe plus qu'en N copies, une par site ;
- ajouter un site, c'est modifier tous les rôles.

Ce serait encoder le « où » dans le « quoi », exactement ce que l'autorisation hiérarchique sépare.

## E7. Un domaine, plusieurs propriétaires, un sous-arbre chacun

### Constat

- La propriété est indexée par domaine seul (`authority/broker.authority.ts`, `domainOwner`). Une seconde identité qui déclare le même domaine est refusée : *« a domain has one owner »*.
- Une identité ne tient qu'une déclaration, donc un seul domaine.
- En revanche, `broker/authorize` borne déjà chaque question au sous-arbre déclaré par le provider qui la pose (`isWithinNamespace`, refus `undeclared-resource`). La décision est donc déjà partitionnée par sous-arbre. Seule la règle de propriété empêche le partage.

### Proposition

**Propriété par (domaine, sous-arbre).** Une déclaration du domaine `d` sur le sous-arbre `N` par l'identité `P` est acceptée si, pour tout autre propriétaire `(P', N')` de `d` avec `P' ≠ P`, ni `N` ne contient `N'`, ni `N'` ne contient `N`. Les sous-arbres frères sont permis. Un sous-arbre qui en contient un autre est refusé : une même ressource aurait deux décideurs.

```text
d = history, déjà possédé par site1 sur /production/site1
  /production/site2       accepté   (frère)
  /production             refusé    (contient /production/site1)
  /production/site1/line1 refusé    (contenu dans /production/site1)
```

**Un vocabulaire par domaine.** Tous les propriétaires d'un domaine déclarent le même ensemble de `capabilities` et de `resultsRequired`. Le premier accepté fixe le vocabulaire, et une déclaration qui en diffère est refusée (*« capability vocabulary differs from the domain's »*). Un rôle reste ainsi valable sur tout le domaine.

**Décision inchangée.** `broker/authorize` reste borné au sous-arbre du provider qui pose la question. Le propriétaire de `/production/site1` ne peut obtenir aucune décision sur `/production/site2`.

**Slots protégés inchangés.** Chaque propriétaire protège ses propres slots de stockage (`protects`), qui restent définis dans le fichier de sécurité (`protectedSlots`, avec `declaredBy`).

### Propriétaires fixés par configuration (recommandé)

Aujourd'hui, la propriété revient au **premier** qui déclare. Au démarrage d'un site, c'est une course : le premier provider connecté avec un `allowedResources` assez large prend le domaine. Comme les `protectedSlots`, les propriétaires peuvent être **fermés dès le démarrage** dans le fichier de sécurité :

```json
{
  "authorization": {
    "domains": {
      "history": [
        { "owner": "mcp-history-site1", "namespace": "/production/site1" },
        { "owner": "mcp-history-site2", "namespace": "/production/site2" }
      ],
      "scada": [{ "owner": "mcp-scada", "namespace": "/production" }]
    }
  }
}
```

- **Domaine listé** : seules les identités et les sous-arbres listés peuvent le déclarer. Le contrôle de disjonction s'applique à la configuration elle-même, et une liste qui se chevauche empêche le démarrage.
- **Domaine non listé** : le comportement actuel, premier arrivé, reste valable, pour la compatibilité et les bancs d'essai.
- **Pas de nouveau droit** : comme `protectedSlots`, la section ne fait que restreindre. Elle désigne qui peut décrire un domaine, elle ne donne aucun droit à un appelant.

### Découverte (optionnelle)

Un client doit savoir quel slot sert `/production/site2`. Le slot `_broker` exposerait une ressource `broker://domains`, en lecture seule et filtrée par la policy comme `broker://providers` : domaine, sous-arbre, slot. C'est aussi la vue V1 « État du domaine » du [brief des pages SCADA](brief_ui_scada_pages_slots.md).

```json
{ "domains": [{ "domain": "history", "owners": [{ "namespace": "/production/site1", "slot": "history-site1", "connected": true }] }] }
```

## E8. Retrait d'une déclaration

### Constat

E1 prévoyait que *« seules une nouvelle déclaration ou une action d'administration »* retirent une déclaration. L'action d'administration n'existe pas. Une déclaration, et la propriété du domaine avec elle, dure donc jusqu'au redémarrage du broker :

- changer l'identité d'un provider demande un redémarrage ;
- avec E7, un site démonté garde son sous-arbre ;
- tant que la déclaration est là, les décisions de ce sous-arbre restent attribuées à un provider qui n'existe plus.

La raison d'origine (*une coupure réseau ne doit pas rouvrir les slots protégés*) ne dépend plus de la déclaration : depuis le broker 1.5.0, les `protectedSlots` sont fermés dès le démarrage par le fichier de sécurité.

### Proposition

1. **Retrait par le propriétaire** : `broker/authorization/withdraw`, sans paramètre, sur son propre socket. C'est l'arrêt propre d'un provider ou un changement de version qui retire le domaine. Les slots protégés restent fermés, car ils relèvent du fichier de sécurité.
2. **Retrait administratif** : un outil `broker_declaration_withdraw({ principal })` sur `_broker`, réservé à la capability `broker.authorization.admin`, comme `broker_limits_release` l'est à `broker.limits.admin`. Il est audité.
3. **Pas de retrait sur déconnexion.** Une coupure réseau ne libère rien. Un délai de grâce après une déconnexion durable a été envisagé, puis écarté en v1 : il rouvrirait la course au domaine.

`broker_diagnose` signale une déclaration dont le provider est déconnecté depuis plus d'un seuil (`declaration-owner-offline`), avec le retrait administratif comme correction.

## Ce qui ne change pas

- La déclaration reste descriptive : aucun rôle, aucune assignation, aucun deny.
- Une identité tient une seule déclaration. Un processus qui sert à la fois l'historique et le cache utilise deux identités, ce qui garde des audits séparés.
- `broker/authorize`, les obligations et l'audit des résultats sont inchangés.

## Compatibilité

- Un seul propriétaire par domaine, sans section `domains` : décisions et refus identiques à la version 1.6.0.
- Le message *« a domain has one owner »* ne sort plus que pour un chevauchement, sous la forme *« namespace overlaps the one owned by provider … »*.
- `broker/authorization/withdraw` sur un broker antérieur reçoit un refus immédiat `-32601`, comme toute méthode `broker/*` inconnue (lot 0 du premier brief).

## Impact sur les domaines UNS

| Domaine | Aujourd'hui | Avec E7 et E8 |
|---|---|---|
| `scada` | un `mcp-scada` pour tout le broker | un `mcp-scada` par site possible, chacun sur son sous-arbre, avec ses slots protocolaires protégés |
| `history` | un slot `history`, avec un routeur central vers les stores | un historien par site ; un routeur reste possible pour une vue consolidée |
| `cache` | un slot `cache` | un cache par site, près des équipements |

`mcp-uns` n'a pas à changer : `BrokerAccessGuard` pose déjà ses questions au broker, qui les borne au sous-arbre du provider.

## Lotissement proposé

| Lot | Contenu | Version visée |
|---|---|---|
| 6 | E8 : `broker/authorization/withdraw`, `broker_declaration_withdraw`, `declaration-owner-offline` dans `broker_diagnose` ; documentation de la règle actuelle (faite) | broker 1.7.0 |
| 7 | E7 : propriété par (domaine, sous-arbre), vocabulaire unique, section `domains` du fichier de sécurité | broker 1.8.0 |
| 8 | E7 : ressource `broker://domains` | broker 1.8.x |

E8 passe avant E7, car il corrige un défaut qui existe déjà avec un seul propriétaire.

## Tests d'acceptation

| # | Test |
|---|---|
| T23 | Deux identités déclarent `history` sur deux sous-arbres frères : les deux sont acceptées, et chacune ne reçoit de décisions que dans son sous-arbre (`undeclared-resource` ailleurs). |
| T24 | Une déclaration dont le sous-arbre contient, ou est contenu dans, celui d'un autre propriétaire du domaine est refusée en entier, avec le propriétaire en conflit nommé. |
| T25 | Une déclaration dont les `capabilities` ou les `resultsRequired` diffèrent de ceux du domaine est refusée. |
| T26 | Avec une section `domains`, une identité ou un sous-arbre non listés ne peuvent pas déclarer le domaine. Une section dont les sous-arbres se chevauchent empêche le démarrage. |
| T27 | Sans section `domains` et avec un seul propriétaire, trames et décisions sont identiques à la version 1.6.0. |
| T28 | Après `broker/authorization/withdraw`, le domaine se déclare depuis une autre identité ; les slots protégés du fichier de sécurité restent fermés. |
| T29 | `broker_declaration_withdraw` est refusé sans `broker.authorization.admin`, accepté et audité avec. |
| T30 | Une déconnexion, même longue, ne libère pas la propriété ; `broker_diagnose` signale `declaration-owner-offline` passé le seuil. |
| T31 | `broker://domains` ne montre à un client que les sous-arbres qu'il peut voir. |

## Questions ouvertes

1. Faut-il permettre à une identité de **posséder plusieurs sous-arbres disjoints** d'un même domaine (un historien qui sert deux sites), avec un `namespaces: [...]` dans la déclaration ? Ou suffit-il qu'il déclare leur parent commun, quand aucun autre propriétaire ne s'y trouve ?
2. Vocabulaire unique par domaine : correspondance **exacte**, ou un nouveau propriétaire peut-il déclarer un sur-ensemble, au risque que les rôles existants ne couvrent pas tout ?
3. La section `domains` doit-elle devenir **obligatoire** dès que le fichier de sécurité existe, pour supprimer la course au premier déclarant en production ?
4. Une vue consolidée (tout l'historique de l'entreprise) passe-t-elle par un **routeur** propriétaire du sous-arbre parent ? E7 l'interdit tant que des sites en sont propriétaires. Il faudrait alors un routeur sans déclaration, qui pose ses questions par les historiens de site, ou une notion de propriétaire « agrégateur ».
