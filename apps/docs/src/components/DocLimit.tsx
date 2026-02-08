import React from 'react';
import Admonition from '@theme/Admonition';

type Props = {
  children: React.ReactNode;
  title?: string;
};

export function DocLimit({ children, title = 'Limit' }: Props): JSX.Element {
  return (
    <Admonition type="caution" title={title}>
      {children}
    </Admonition>
  );
}
