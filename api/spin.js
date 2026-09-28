import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    // Check cooldown (24 hours)
    const { data: cooldownData } = await supabase
      .from('user_cooldowns')
      .select('last_spun_at')
      .eq('identifier', clientIp)
      .single();

    if (cooldownData) {
      const lastSpun = new Date(cooldownData.last_spun_at).getTime();
      const now = new Date().getTime();
      const hoursPassed = (now - lastSpun) / (1000 * 60 * 60);
      if (hoursPassed < 24) {
        return res.status(429).json({ error: 'You are on cooldown. Try again later.' });
      }
    }

    // Fetch available prizes
    const { data: prizes, error: fetchError } = await supabase
      .from('available_prizes')
      .select('*');

    if (fetchError || !prizes || prizes.length === 0) {
      return res.status(400).json({ error: 'No prizes left in stock!' });
    }

    // Weighted random selection algorithm
    const totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
    let randomNum = Math.random() * totalWeight;
    let selectedPrize = prizes[0];

    for (const prize of prizes) {
      if (randomNum < prize.weight) {
        selectedPrize = prize;
        break;
      }
      randomNum -= prize.weight;
    }

    // If it's a username, remove it from stock so it can't be won twice
    if (selectedPrize.prize_type === 'username') {
      await supabase.from('available_prizes').delete().eq('id', selectedPrize.id);
    }

    // Update cooldown for IP
    await supabase.from('user_cooldowns').upsert({
      identifier: clientIp,
      last_spun_at: new Date().toISOString()
    });

    // Generate a visual reel of 30 items where index 15 lands on the winner
    const reel = [];
    for (let i = 0; i < 30; i++) {
      if (i === 15) {
        reel.push(selectedPrize.value);
      } else {
        const randomFiller = prizes[Math.floor(Math.random() * prizes.length)];
        reel.push(randomFiller.value);
      }
    }

    // Custom claim messages based on prize type
    let claimMessage = '';
    if (selectedPrize.prize_type === 'username') {
      claimMessage = `Claim your username at https://guns.lol/`;
    } else {
      claimMessage = `Open a ticket with proof in discord.gg/vaultsociety to claim.`;
    }

    return res.status(200).json({
      success: true,
      prize: selectedPrize.value,
      type: selectedPrize.prize_type,
      message: claimMessage,
      reel: reel
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error during spin.' });
  }
}