import { pluralize } from '@stoplight/spectral/dist/formatters/utils';

export const pluralizer = (howMany: number, word: string) => {
  return `${howMany} ${pluralize(word, howMany)}`;
};
