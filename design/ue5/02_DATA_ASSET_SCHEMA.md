# UE5 Data-Asset Schema (mirror of `species.json` + `archetypes.json`)

The browser game's data-driven core is its best engine-agnostic asset. This doc maps it 1:1 onto UE5 `UPrimaryDataAsset`s so the **same numbers** drive the photoreal build and adding a species/hybrid stays config-only.

> Field parity is deliberate: every key here exists in the live `data/species.json` / `data/archetypes.json`. Where the browser JSON nests (`size`, `move`, `senses`, `combat`, `behavior`), UE5 uses `USTRUCT`s with the same field names so a JSON→DataAsset importer is a mechanical mapping.

## C++ structs (mirror the JSON sub-objects)

```cpp
USTRUCT(BlueprintType) struct FCreatureSize {
    UPROPERTY(EditAnywhere) float LengthM = 0.f;     // size.lengthM
    UPROPERTY(EditAnywhere) float MassKg  = 0.f;     // size.massKg
    UPROPERTY(EditAnywhere) float EyeHeightM = 0.f;  // size.eyeHeightM
};
USTRUCT(BlueprintType) struct FCreatureMove {
    UPROPERTY(EditAnywhere) float Walk = 0.f;        // move.walk  (m/s)
    UPROPERTY(EditAnywhere) float Run  = 0.f;        // move.run
    UPROPERTY(EditAnywhere) float TurnRateDeg = 0.f; // move.turnRate
};
USTRUCT(BlueprintType) struct FCreatureSenses {
    UPROPERTY(EditAnywhere) float SightRangeM = 0.f; // senses.sightRangeM
    UPROPERTY(EditAnywhere) float SightFovDeg = 0.f; // senses.sightFovDeg
    UPROPERTY(EditAnywhere) float HearingRangeM = 0.f;
};
USTRUCT(BlueprintType) struct FCreatureCombat {
    UPROPERTY(EditAnywhere) float Damage = 0.f;
    UPROPERTY(EditAnywhere) float AttackRangeM = 0.f;
    UPROPERTY(EditAnywhere) float AttackCooldownS = 0.f;
    UPROPERTY(EditAnywhere) float Health = 0.f;
};
USTRUCT(BlueprintType) struct FCreatureBehavior {
    UPROPERTY(EditAnywhere) float Aggression = 0.f;        // 0..1
    UPROPERTY(EditAnywhere) float TerritoryRadiusM = 0.f;
    UPROPERTY(EditAnywhere) ESocial Social = ESocial::Solitary;  // herd|pack|solitary
    UPROPERTY(EditAnywhere) float FleeHealthPct = 0.f;
    UPROPERTY(EditAnywhere) float FleeFromPredatorM = 0.f;
    UPROPERTY(EditAnywhere) float NoiseDrawWeight = 0.f;   // wired (was declared-unused in v1)
    UPROPERTY(EditAnywhere) TArray<FName> PackRoles;       // lead/flank/harry — wired
};
```

## Archetype Data Asset (`DA_Archetype_*`) — mirrors `archetypes.json`

```cpp
UENUM() enum class EBehaviorClass : uint8 { Prey, Predator };

UCLASS(BlueprintType) class UArchetypeDataAsset : public UPrimaryDataAsset {
    UPROPERTY(EditAnywhere) EBehaviorClass BehaviorClass; // behaviorClass
    UPROPERTY(EditAnywhere) FName BaseState;              // baseState  (Graze/Patrol/...)
    UPROPERTY(EditAnywhere) bool bPackTactics = false;    // packTactics
    UPROPERTY(EditAnywhere) bool bApexThreat  = false;    // apexThreat
    // forward-declared flags (read by states added in later migration steps):
    UPROPERTY(EditAnywhere) bool bStalkPreferred = false;
    UPROPERTY(EditAnywhere) bool bFightsWhenCornered = false;
};
```

The **8 archetypes** become 8 assets, values copied verbatim from `archetypes.json`:
`DA_Archetype_SmallHerbivore`, `_HerdGrazer`, `_HerdGrazerArmored`, `_PackHunter`, `_Ambush`, `_Pursuit`, `_Water`, `_Apex`.

## Creature Data Asset (`DA_Creature_*`) — mirrors a `species.json` row

```cpp
UCLASS(BlueprintType) class UCreatureDataAsset : public UPrimaryDataAsset {
    UPROPERTY(EditAnywhere) FName Id;                 // id
    UPROPERTY(EditAnywhere) FText DisplayName;        // displayName
    UPROPERTY(EditAnywhere) EDiet Diet;               // diet
    UPROPERTY(EditAnywhere) FName Role;               // role — kept for HUD/minimap only
    UPROPERTY(EditAnywhere) UArchetypeDataAsset* Archetype;  // archetype (the AI reads THIS)
    UPROPERTY(EditAnywhere) FCreatureSize    Size;
    UPROPERTY(EditAnywhere) FCreatureMove    Move;
    UPROPERTY(EditAnywhere) FCreatureSenses  Senses;
    UPROPERTY(EditAnywhere) FCreatureCombat  Combat;
    UPROPERTY(EditAnywhere) FCreatureBehavior Behavior;
    UPROPERTY(EditAnywhere) TArray<FName> AnimSet;    // animSet
    // visual binding (replaces browser greybox + modelPath):
    UPROPERTY(EditAnywhere) TSoftObjectPtr<USkeletalMesh> Mesh;
    UPROPERTY(EditAnywhere) TSubclassOf<UAnimInstance>   AnimClass; // ABP_Biped / ABP_Quadruped
    UPROPERTY(EditAnywhere) float ModelYawOffset = 0.f;
};
```

### Filled example — T-Rex (`DA_Creature_TRex`, from the real `species.json` row)
```
Id=trex  DisplayName="Tyrannosaurus Rex"  Diet=Carnivore  Role=apex
Archetype=DA_Archetype_Apex
Size:  Length 12.5  Mass 8000  EyeHeight 4.0
Move:  Walk 2.8  Run 10.5  Turn 110
Senses: Sight 70  FOV 130  Hearing 110
Combat: Damage 55  Range 4.5  Cooldown 1.8  Health 600
Behavior: Aggression 0.55  Territory 220  Social Solitary  FleeHealthPct 0.0  NoiseDrawWeight 1.0
AnimSet: idle, walk, run, attack, roar, stagger, die
Mesh: SK_TRex  AnimClass: ABP_Biped
```

### Filled example — Triceratops (`DA_Creature_Triceratops`)
```
Id=triceratops  DisplayName="Triceratops"  Diet=Herbivore  Role=grazer
Archetype=DA_Archetype_HerdGrazerArmored
Size:  Length 9.0  Mass 9000  EyeHeight 2.5
Move:  Walk 2.0  Run 8.0  Turn 140
Senses: Sight 45  FOV 250  Hearing 50
Combat: Damage 40  Range 3.0  Cooldown 1.5  Health 700
Behavior: Aggression 0.0  Territory 80  Social Herd  FleeHealthPct 0.4  FleeFromPredatorM 30
AnimSet: idle, walk, run, graze, charge, stagger, die
Mesh: SK_Triceratops  AnimClass: ABP_Quadruped
```

## JSON → Data Asset importer (one-time, then data stays in editor)

A small editor utility (`UCreatureImportFactory` or a Python `unreal` script) reads the existing `species.json` / `archetypes.json` and emits `DA_*` assets:
1. Parse `archetypes.json` → create/update each `UArchetypeDataAsset`.
2. Parse `species.json` → for each row, create/update `UCreatureDataAsset`, resolve `archetype` string → the matching `DA_Archetype_*`, copy nested objects field-for-field, leave `Mesh`/`AnimClass` for the artist to assign.
3. Re-runnable: keying on `Id` makes it idempotent, so the browser game stays the **single source of truth for tuning** — re-import after balancing in the browser build.

## Why this matters

The browser AI never branches on species — it dispatches on archetype helpers. UE5 does the same: `ACreatureBase` reads `DataAsset->Archetype->BehaviorClass/bPackTactics/bApexThreat` to pick StateTree behavior (next doc). So the **30-species roster + future hybrids drop in as Data Assets**, exactly as designed for the browser game. The two declared-but-unused browser fields (`noiseDrawWeight`, `packRoles`) are wired here as first-class properties.
