import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/search',
    component: ComponentCreator('/search', '822'),
    exact: true
  },
  {
    path: '/docs',
    component: ComponentCreator('/docs', 'ace'),
    routes: [
      {
        path: '/docs',
        component: ComponentCreator('/docs', 'eef'),
        routes: [
          {
            path: '/docs',
            component: ComponentCreator('/docs', 'a68'),
            routes: [
              {
                path: '/docs/architecture/overview',
                component: ComponentCreator('/docs/architecture/overview', '8f4'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/category/architecture',
                component: ComponentCreator('/docs/category/architecture', '2c5'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/category/getting-started',
                component: ComponentCreator('/docs/category/getting-started', 'd48'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/category/mcp-tools',
                component: ComponentCreator('/docs/category/mcp-tools', '285'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/contributing/docs-contribution',
                component: ComponentCreator('/docs/contributing/docs-contribution', 'efe'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/contributing/versioning-strategy',
                component: ComponentCreator('/docs/contributing/versioning-strategy', 'c98'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/extension/overview',
                component: ComponentCreator('/docs/extension/overview', '72d'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/faq',
                component: ComponentCreator('/docs/faq', 'ec8'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/getting-started/local-debug-session',
                component: ComponentCreator('/docs/getting-started/local-debug-session', '75d'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/getting-started/quick-start',
                component: ComponentCreator('/docs/getting-started/quick-start', '835'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/intro',
                component: ComponentCreator('/docs/intro', '058'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/mcp-tools/overview',
                component: ComponentCreator('/docs/mcp-tools/overview', 'd04'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/mcp-tools/v1-query-tools',
                component: ComponentCreator('/docs/mcp-tools/v1-query-tools', 'bd1'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/mcp-tools/v2-heavy-capture',
                component: ComponentCreator('/docs/mcp-tools/v2-heavy-capture', '34b'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/mcp-tools/v3-correlation',
                component: ComponentCreator('/docs/mcp-tools/v3-correlation', '8bb'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/reference/limits-and-redaction',
                component: ComponentCreator('/docs/reference/limits-and-redaction', '72f'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/security-privacy/controls',
                component: ComponentCreator('/docs/security-privacy/controls', '5c6'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/server/overview',
                component: ComponentCreator('/docs/server/overview', '7cf'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/testing/strategy',
                component: ComponentCreator('/docs/testing/strategy', '12b'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/troubleshooting/common-issues',
                component: ComponentCreator('/docs/troubleshooting/common-issues', 'eaf'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/workflows/failure-diagnosis-playbook',
                component: ComponentCreator('/docs/workflows/failure-diagnosis-playbook', '602'),
                exact: true,
                sidebar: "docsSidebar"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '/',
    component: ComponentCreator('/', 'e5f'),
    exact: true
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
