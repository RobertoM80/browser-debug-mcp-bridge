import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Browser Debug MCP Bridge Docs',
  tagline: 'Privacy-first browser debugging with MCP',
  url: 'https://example.invalid',
  baseUrl: '/',
  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'throw',
  i18n: {
    defaultLocale: 'en',
    locales: ['en']
  },
  themes: ['@easyops-cn/docusaurus-search-local'],
  themeConfig: {
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true
    },
    navbar: {
      title: 'Browser Debug MCP Bridge',
      items: [
        { to: '/docs/intro', label: 'Docs', position: 'left' },
        { to: '/docs/getting-started/quick-start', label: 'Getting Started', position: 'left' },
        { to: '/docs/mcp-tools/overview', label: 'MCP Tools', position: 'left' }
      ]
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Core',
          items: [
            { label: 'Architecture', to: '/docs/architecture/overview' },
            { label: 'Security & Privacy', to: '/docs/security-privacy/controls' }
          ]
        },
        {
          title: 'Operate',
          items: [
            { label: 'Testing', to: '/docs/testing/strategy' },
            { label: 'Troubleshooting', to: '/docs/troubleshooting/common-issues' }
          ]
        }
      ]
    },
    prism: {
      additionalLanguages: ['bash', 'json']
    }
  },
  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          editUrl: undefined
        },
        blog: false,
        pages: false,
        theme: {
          customCss: './src/css/custom.css'
        }
      } satisfies Preset.Options
    ]
  ],
  plugins: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        language: ['en'],
        docsRouteBasePath: '/docs',
        indexDocs: true,
        indexPages: false,
        explicitSearchResultPath: true
      }
    ]
  ]
};

export default config;
