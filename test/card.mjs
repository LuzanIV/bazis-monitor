// Отрисовка примера карточки «итоги недели» → test/shots/week-card*.png (для глаз).
// Тестирует настоящий src/45-card.js: вшивает атлас, вызывает weeklyCard, пишет PNG.
import fs from 'node:fs';
const u = (p) => new URL(p, import.meta.url);

let code = fs.readFileSync(u('../src/45-card.js'), 'utf8');
const fontJson = fs.readFileSync(u('../app/card-font.json'), 'utf8');
code = code.replace("'__CARD_FONT__'", JSON.stringify(fontJson));
const { weeklyCard } = new Function('console', code + '\nreturn { weeklyCard };')(console);

const days = (arr) => arr.map(([label, date, state, h]) => ({ label, date, state, h }));

const samples = {
  'week-card': {
    title: 'Итоги недели',
    range: '22–28 сентября',
    availText: '99,98%',
    availState: 'good',
    stats: [
      { dot: 'crit', text: '1 падение', strong: true },
      { text: 'простой  6 мин' },
      { text: 'ответ  0,4 с · p95 1,1 с' },
    ],
    days: days([
      ['Пн', '22', 'good', 1], ['Вт', '23', 'good', 1], ['Ср', '24', 'crit', 0.72],
      ['Чт', '25', 'good', 1], ['Пт', '26', 'warn', 0.94], ['Сб', '27', 'planned', 0.5], ['Вс', '28', 'good', 1],
    ]),
  },
  'week-card-clean': {
    title: 'Итоги недели',
    range: '15–21 сентября',
    availText: '100%',
    availState: 'good',
    stats: [
      { dot: 'good', text: 'падений не было', strong: true },
      { text: 'простой  0' },
      { text: 'ответ  0,3 с · p95 0,8 с' },
    ],
    days: days([
      ['Пн', '15', 'good', 1], ['Вт', '16', 'good', 1], ['Ср', '17', 'good', 1],
      ['Чт', '18', 'good', 1], ['Пт', '19', 'good', 1], ['Сб', '20', 'good', 1], ['Вс', '21', 'good', 1],
    ]),
  },
  'week-card-bad': {
    title: 'Итоги недели',
    range: '8–14 сентября',
    availText: '97,3%',
    availState: 'crit',
    stats: [
      { dot: 'crit', text: '4 падения', strong: true },
      { text: 'простой  4 ч 41 мин' },
      { text: 'ответ  0,6 с · p95 2,4 с' },
    ],
    days: days([
      ['Пн', '8', 'crit', 0.4], ['Вт', '9', 'good', 1], ['Ср', '10', 'crit', 0.6],
      ['Чт', '11', 'warn', 0.9], ['Пт', '12', 'crit', 0.7], ['Сб', '13', 'nodata', null], ['Вс', '14', 'good', 1],
    ]),
  },
};

fs.mkdirSync(u('./shots/'), { recursive: true });
for (const [name, d] of Object.entries(samples)) {
  const png = weeklyCard(d);
  if (!png) throw new Error('weeklyCard вернул null — атлас не загрузился');
  fs.writeFileSync(u('./shots/' + name + '.png'), png);
  console.log(`${name}.png: ${(png.length / 1024).toFixed(0)} КБ`);
}
console.log('готово');
