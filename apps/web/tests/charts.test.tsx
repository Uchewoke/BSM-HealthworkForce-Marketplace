import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, it } from 'vitest';
import { BarList, ChartCard, ColumnChart, StatTile, money, percent } from '../components/Charts';

const trend = [
  { bucket: '2026-10-05', posted: 4, filled: 3 },
  { bucket: '2026-10-12', posted: 8, filled: 2 },
  { bucket: '2026-10-19', posted: 0, filled: 0 },
];
const series = [{ key: 'posted', label: 'Positions posted' }, { key: 'filled', label: 'Positions filled' }];

describe('charts', () => {
  it('names every series in a legend and describes the data to assistive technology', () => {
    render(<ColumnChart data={trend} series={series} bucket="week" caption="Positions posted and filled" />);
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent('Positions posted');
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent('Positions filled');
    expect(screen.getByRole('group')).toHaveAccessibleName(/Positions posted and filled.*Positions posted 4, Positions filled 3/);
  });

  it('has no legend for a single series, and shows each period\'s values on hover and keyboard focus', () => {
    render(<ColumnChart data={trend} series={[series[0]!]} bucket="week" caption="Posted" />);
    expect(screen.queryByRole('list', { name: 'Legend' })).not.toBeInTheDocument();
    const target = screen.getByRole('img', { name: /^Oct 12: Positions posted 8/ });
    fireEvent.mouseEnter(target);
    expect(screen.getByRole('status')).toHaveTextContent('Positions posted: 8');
    fireEvent.mouseLeave(target.closest('svg')!);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole('img', { name: /^Oct 5: Positions posted 4/ }));
    expect(screen.getByRole('status')).toHaveTextContent('Positions posted: 4');
  });

  it('does not break when there is no data at all', () => {
    const empty = trend.map((t) => ({ ...t, posted: 0, filled: 0 }));
    const { container } = render(<ColumnChart data={empty} series={series} bucket="month" caption="Nothing" />);
    expect(container.querySelectorAll('rect[fill^="var(--viz-s"]')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    render(<ColumnChart data={[]} series={series} bucket="week" caption="No periods" />);
  });

  it('sizes ranked bars from the numbers, keeps tiny values visible and says so when empty', () => {
    const { container } = render(<BarList rows={[{ name: 'RN', value: 50, label: '50%' }, { name: 'LPN', value: 1, label: '1%' }, { name: 'CNA', value: 0, label: '0%' }]} max={100} />);
    const fills = [...container.querySelectorAll<HTMLElement>('.fill')].map((f) => f.style.width);
    expect(fills).toEqual(['50%', '1.5%', '0%']);
    expect(screen.getByLabelText('RN: 50%')).toBeInTheDocument();
    render(<BarList rows={[]} />);
    expect(screen.getByText('No data for this period.')).toBeInTheDocument();
  });

  it('offers the same numbers as a table', async () => {
    render(<ChartCard title="Fill" table={<table><caption>Fill table</caption><tbody><tr><td>RN</td><td>50%</td></tr></tbody></table>}><BarList rows={[{ name: 'RN', value: 50, label: '50%' }]} /></ChartCard>);
    expect(screen.queryByText('Fill table')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View as table' }));
    expect(screen.getByText('Fill table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View as chart' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('formats figures honestly', () => {
    expect(percent(null)).toBe('—');
    expect(percent(0)).toBe('0%');
    expect(money(44_000)).toBe('$440');
    render(<StatTile label="Fill rate" value="50%" note="1 of 2 positions filled" />);
    expect(screen.getByText('1 of 2 positions filled')).toBeInTheDocument();
  });

  it('passes automated accessibility checks', async () => {
    const { container } = render(
      <>
        <StatTile label="Fill rate" value="50%" />
        <ColumnChart data={trend} series={series} bucket="week" caption="Positions posted and filled" />
        <BarList rows={[{ name: 'RN', value: 50, label: '50%' }]} />
      </>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
