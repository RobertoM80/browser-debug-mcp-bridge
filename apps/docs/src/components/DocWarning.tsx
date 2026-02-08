import React from 'react';
import Admonition from '@theme/Admonition';

type Props = {
  children: React.ReactNode;
  title?: string;
};

export function DocWarning({ children, title = 'Warning' }: Props): JSX.Element {
  return (
    <Admonition type="warning" title={title}>
      {children}
    </Admonition>
  );
}
