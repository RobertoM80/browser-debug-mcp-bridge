import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const repositoryOwner = process.env.GITHUB_REPOSITORY_OWNER || 'robertom80';
const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'browser-debug-mcp-bridge';
const isLocalDev = process.env.NODE_ENV === 'development' && !process.env.CI;
const siteUrl = process.env.DOCS_SITE_URL || `https://${repositoryOwner}.github.io`;
const baseUrl = process.env.DOCS_BASE_URL || (isLocalDev ? '/' : `/${repositoryName}/`);

const config: Config = {
  title: 'Browser Debug MCP Bridge Docs',
  tagline: 'Privacy-first browser debugging with MCP',
  url: siteUrl,
  baseUrl,
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw'
    }
  },
  i18n: {
    defaultLocale: 'en',
    locales: ['en']
  },
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
            { label: 'Getting Started', to: '/docs/getting-started/quick-start' },
            { label: 'MCP Tools', to: '/docs/mcp-tools/overview' },
            { label: 'Security & Privacy', to: '/docs/security-privacy/controls' }
          ]
        },
        {
          title: 'Support',
          items: [
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
          editUrl: undefined,
          exclude: [
            '**/contributing/**',
            '**/workflows/**',
            '**/testing/**',
            '**/architecture/**',
            '**/server/**'
          ]
        },
        blog: false,
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
        indexBlog: false,
        indexPages: false,
        explicitSearchResultPath: true
      }
    ]
  ]
};

export default config;
