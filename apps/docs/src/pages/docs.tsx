import { Redirect } from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

export default function DocsRedirect(): JSX.Element {
  const target = useBaseUrl('/docs/intro');
  return <Redirect to={target} />;
}
