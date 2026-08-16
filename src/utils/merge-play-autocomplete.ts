import {APIApplicationCommandOptionChoice} from 'discord-api-types/v10';

export const mergePlayAutocomplete = (
  groups: APIApplicationCommandOptionChoice[][],
  slots: number,
): APIApplicationCommandOptionChoice[] => {
  const cap = Math.max(0, slots);
  const present = groups.filter(group => group.length > 0);
  if (cap === 0 || present.length === 0) {
    return [];
  }

  const quotas = present.map(() => 0);
  let remaining = cap;
  let progressed = true;

  while (remaining > 0 && progressed) {
    progressed = false;
    for (let index = 0; index < present.length && remaining > 0; index++) {
      const group = present[index];
      if (group && quotas[index] < group.length) {
        quotas[index]++;
        remaining--;
        progressed = true;
      }
    }
  }

  return present.flatMap((group, index) => group.slice(0, quotas[index]));
};
