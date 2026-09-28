import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Allow GET requests to fetch recent winners ticker
  if (req.method === 'GET') {
    try {
      const { data: winners } = await supabase
        .from('recent_winners')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5);

      return res.status(200).json({ winners: winners || [] });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch winners' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userToken } = req.body || {};

  if (!userToken) {
    return res.status(400).json({ error: 'Invalid session token.' });
  }

  try {
    // Check cooldown based on anonymous browser token (no IPs tracked)
    const { data: cooldownData } = await supabase
      .from('user_cooldowns')
      .select('last_spun_at')
      .eq('user_token', userToken)
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

    // Update cooldown using the anonymous browser token
    await supabase.from('user_cooldowns').upsert({
      user_token: userToken,
      last_spun_at: new Date().toISOString()
    }, { onConflict: 'user_token' });

    // Record win in recent_winners table
    await supabase.from('recent_winners').insert({
      prize: selectedPrize.value,
      prize_type: selectedPrize.prize_type
    });

    // Generate visual reel items
    const reel = [];
    for (let i = 0; i < 30; i++) {
      if (i === 15) {
        reel.push(selectedPrize.value);
      } else {
        const randomFiller = prizes[Math.floor(Math.random() * prizes.length)];
        reel.push(randomFiller.value);
      }
    }

    let claimMessage = '';
    if (selectedPrize.prize_type === 'username') {
      claimMessage = `Claim your username at https://guns.lol/`;
    } else {
      claimMessage = `Open a ticket with proof in discord.gg/vaultsociety to claim.`;
    }

    const { data: updatedWinners } = await supabase
      .from('recent_winners')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    return res.status(200).json({
      success: true,
      prize: selectedPrize.value,
      type: selectedPrize.prize_type,
      message: claimMessage,
      reel: reel,
      winners: updatedWinners || []
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error during spin.' });
  }
}