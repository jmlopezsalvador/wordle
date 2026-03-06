const REMINDER_MESSAGES = [
  "¿Te pagan por mirar la pantalla? Sube los {missing} resultados que faltan en {groupName} ({activeDay}), vago.",
  "Deja de rascarte la barriga. Aún debes {missing} resultados de {groupName} para el {activeDay}.",
  "Hola, genio. Te olvidaste de {missing} resultados en {groupName} el {activeDay}. Trabaja un poco, anda.",
  "A ver si espabilas, que el día {activeDay} no se va a cerrar solo. Faltan {missing} en {groupName}.",
  "¿Necesitas una invitación formal con sello lacrado? Pon los {missing} resultados de {groupName} del {activeDay}.",
  "Tu nivel de procrastinación es legendario. Te faltan {missing} tristes resultados en {groupName} ({activeDay}).",
  "A ver, alma de cántaro, el sistema no es adivino. Faltan {missing} datos en {groupName} ({activeDay}).",
  "Si fueras tan rápido trabajando como quejándote... Faltan {missing} en {groupName} ({activeDay}).",
  "Otra vez yo, amargándote la existencia porque no haces tu trabajo. Faltan {missing} de {groupName} ({activeDay}).",
  "Despierta, que pareces un zombie. Te quedan {missing} en {groupName} para el {activeDay}.",
  "¿Planeas terminar hoy o en el próximo milenio? Faltan {missing} malditos datos en {groupName} ({activeDay}).",
  "Deja el móvil ya y rellena los {missing} huecos que dejaste en {groupName} para el {activeDay}, haz el favor.",
  "Tu ineficiencia me sorprende cada día un poco más. Te faltan {missing} en {groupName} el {activeDay}.",
  "TIC TAC. El tiempo pasa y tú sigues debiendo {missing} puñeteros resultados de {groupName} ({activeDay}).",
  "Voy a empezar a cobrarte por recordarte que te faltan {missing} en {groupName} ({activeDay}).",
  "¿En serio te ibas a ir sin poner los {missing} resultados de {groupName} ({activeDay})? Qué poca vergüenza.",
  "Que alguien le dé un café a este ser humano para que meta los {missing} datos que faltan en {groupName} ({activeDay}).",
  "Me tienes harto. O metes ya los {missing} resultados de {groupName} ({activeDay}) o me declaro en huelga.",
  "Tengo que decírtelo como a los niños pequeños: mete las {missing} cosas que faltan en {groupName} ({activeDay}).",
  "Premio al empleado del mes... ah no, que te faltan {missing} resultados en {groupName} para {activeDay}. Vuelve al curro."
];

function randomItem<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

export function buildTelegramReminderMessage(input: {
  groupName: string;
  missing: number;
  activeDay: string;
  groupCode: string;
}) {
  const base = randomItem(REMINDER_MESSAGES);
  const text = base
    .replace("{groupName}", input.groupName)
    .replace("{missing}", String(input.missing))
    .replace("{activeDay}", input.activeDay);

  return `${text}\nEnvia tu share directamente por este chat.\nGrupo activo: ${input.groupName} (${input.groupCode})`;
}


