import { test, expect } from '@playwright/test';

test('real MBTA journey traverses the API outbox, Kafka worker and live browser', async ({ page }) => {
  test.setTimeout(180000);
  test.skip(process.env.HOPAHEAD_LIVE_TEST !== '1','Opt in while the full stack and MBTA service are available.');
  await page.goto('/');
  await expect(page.getByLabel('Your Red Line departure')).toBeVisible();
  await expect.poll(async () => page.getByLabel('Your Red Line departure').inputValue(),{timeout:150000}).not.toBe('');
  await page.getByLabel('Extra transfer time').fill('1');
  await page.getByRole('button',{name:'Watch this connection',exact:true}).click();
  await expect.poll(async () => {
    const response=await page.request.get('/api/journey');
    const journey=await response.json();
    return journey?.advice?.ruleVersion;
  },{timeout:30000}).toBe('connection-margin-v1');
  const journey=await (await page.request.get('/api/journey')).json();
  expect(journey.history.length).toBeGreaterThan(0);
  expect(journey.settings.extraTransferSeconds).toBe(60);
  expect(journey.advice.source.topic).toBe('hopahead.mbta.predictions.v1');
  await expect(page.getByRole('heading',{name:journey.advice.headline,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Replay lab',exact:true}).click();
  await expect(page.getByText(/simulated/i).first()).toBeVisible();
  await page.request.delete('/api/journey',{headers:{Origin:process.env.PUBLIC_ORIGIN??'http://localhost:3000'}});
});
