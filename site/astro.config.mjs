// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// The docs site (ADR-0048), published under the Mini App's Pages root at /docs/.
export default defineConfig({
  site: 'https://igorkonovalov.github.io',
  base: '/personal_expenses_bot/docs/',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Бот учёта трат',
      defaultLocale: 'root',
      locales: { root: { label: 'Русский', lang: 'ru' } },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/IgorKonovalov/personal_expenses_bot',
        },
      ],
      sidebar: [
        {
          label: 'Руководство',
          items: [{ autogenerate: { directory: 'guide' } }],
        },
      ],
    }),
  ],
});
