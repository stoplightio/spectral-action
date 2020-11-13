import { pluralize } from '@stoplight/spectral/dist/cli/formatters/utils/pluralize';

export const pluralizer = (howMany: number, word: string) => {
  return `${howMany} ${pluralize(word, howMany)}`;
};
