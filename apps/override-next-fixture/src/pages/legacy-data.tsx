import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';

interface LegacyDataSignal {
  mode: string;
  message: string;
  badge: string;
}

interface LegacyDataPageProps {
  signal: LegacyDataSignal;
}

export const getServerSideProps: GetServerSideProps<LegacyDataPageProps> = async () => ({
  props: {
    signal: {
      mode: 'original-next-data',
      message: 'Original Next data response from Pages Router.',
      badge: 'pages-stable',
    },
  },
});

export default function LegacyDataPage({ signal }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <main data-fixture-page="legacy-data">
      <p>Pages Router data route</p>
      <h1 id="legacy-data-mode">{signal.mode}</h1>
      <p id="legacy-data-message">{signal.message}</p>
      <span id="legacy-data-badge">{signal.badge}</span>
    </main>
  );
}
