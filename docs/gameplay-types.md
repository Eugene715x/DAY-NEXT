# Типы зданий, биомов и профили ресурсов

`gameplay-types.js` содержит независимый игровой каталог. Исходные OSM-теги и контуры не заменяются игровыми типами.

- `BUILDING_TYPES` — устойчивые ID вида `building.house`, `building.medical`, `building.religious`, `building.education`, `building.industrial`, `building.unknown`.
- `BIOME_TYPES` — ID вида `biome.residential`, `biome.parking`, `biome.healthcare`, `biome.forest` и другие типы ландшафта и зон.
- `RESOURCE_PROFILES` — общие списки кандидатов для каждого назначения: бытовые припасы, медицина, промышленность, транспорт и другие.
- `RESOURCE_KINDS` — единый справочник категорий ресурсов. Каждый профиль ссылается на этот справочник.

Чтобы изменить потенциальный набор ресурсов сразу для всех объектов одного типа, отредактируйте его `resourceProfileIds` или общий список `candidateResourceIds` соответствующего профиля. Объекты не хранят копии таблиц ресурсов.

Эти списки — начальные настройки дизайна возможных игровых ресурсов. Они не описывают реальное содержимое домов и пока не создают предметы, вероятности добычи, количество лута или инвентарь.

## Назначение и состояние здания

`classifyBuilding(feature)` возвращает `typeId`, `typeName`, `resourceProfileIds`, `condition`, `sourceType` и `classificationSource`. Явное назначение из `amenity`, `healthcare`, `shop`, `tourism` или `office` имеет приоритет перед общим физическим типом постройки. Тип назначения и состояние независимы: руины больницы остаются `building.medical` с `condition: "ruined"`.

`building=yes` без назначения остаётся `building.unknown`. Название улицы, близость к магазину или попадание в жилой квартал не превращают неизвестное здание в дом или магазин. Крупная административная территория имеет тип `biome.administrative` с пустым списком профилей: она может включать пустыню и не означает жилой квартал.

Сезонные и пересыхающие русла имеют отдельный игровой тип `biome.dry_riverbed`, который не наследует профиль водных ресурсов от постоянного водоёма.

## Пересекающиеся биомы

`classifyBiome()` принимает каноническое название биома, описание зоны с полем `biome` или исходный объект. `collectResourceProfiles()` объединяет профили нескольких зон и здания, исключая повторы. `collectResourceCandidates()` объединяет категории кандидатов так же, без повторов и выдачи предметов.

```js
const hospital = classifyBuilding({ tags: { building: 'yes', amenity: 'hospital' } });
const parking = classifyBiome('parking');
const neighborhood = classifyBiome('residential');
const profileIds = collectResourceProfiles(hospital, parking, neighborhood);
```

Все функции работают локально без загрузки дополнительных файлов. Каталоги неизменяемы во время игры; результаты классификации содержат отдельные массивы ссылок на профили.
