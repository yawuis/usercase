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
    return res.status(200).end();
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server configuration error: Missing Supabase keys.' });
  }

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
    // Check cooldown (24 hours)
    const { data: cooldownData } = await supabase
      .from('user_cooldowns')
      .select('last_spun_at')
      .eq('user_token', userToken)
      .maybeSingle();

    if (cooldownData && cooldownData.last_spun_at) {
      const lastSpun = new Date(cooldownData.last_spun_at).getTime();
      const now = new Date().getTime();
      const hoursPassed = (now - lastSpun) / (1000 * 60 * 60);
      if (hoursPassed < 24) {
        const hoursLeft = Math.ceil(24 - hoursPassed);
        return res.status(429).json({ error: `You are on cooldown. Try again in about ${hoursLeft} hours.` });
      }
    }

    // 1. Fetch static prizes (vouchers, discord access) from available_prizes
    const { data: staticPrizes } = await supabase.from('available_prizes').select('*');
    
    // 2. Fetch available usernames from available_usernames table
    const { data: usernameRows } = await supabase.from('available_usernames').select('*');

    const combinedPool = [];

    // Add static prizes (like vouchers/discord)
    if (staticPrizes) {
      for (const p of staticPrizes) {
        combinedPool.push({
          id: p.id,
          prize_type: p.prize_type,
          value: p.value,
          weight: p.weight || 1,
          isTableUsername: false
        });
      }
    }

    // Add usernames into the pool. 
    // We assign them an aggregate high weight so usernames are common overall!
    if (usernameRows && usernameRows.length > 0) {
      // Let's treat usernames as a whole category with a high combined weight (e.g., weight 85 total split among them)
      // Or give each username an individual weight so they represent roughly ~70-80% of total drops.
      for (const u of usernameRows) {
        combinedPool.push({
          id: u.id,
          prize_type: 'username',
          value: `@${u.username}`,
          weight: 4, // individual weight per username option
          isTableUsername: true
        });
      }
    }

    if (combinedPool.length === 0) {
      return res.status(400).json({ error: 'No prizes left in stock!' });
    }

    // Weighted random selection algorithm
    const totalWeight = combinedPool.reduce((sum, p) => sum + p.weight, 0);
    let randomNum = Math.random() * totalWeight;
    let selectedPrize = combinedPool[0];

    for (const prize of combinedPool) {
      if (randomNum < prize.weight) {
        selectedPrize = prize;
        break;
      }
      randomNum -= prize.weight;
    }

    // If it's a username from the available_usernames table, delete it so it can't be won twice
    if (selectedPrize.isTableUsername) {
      await supabase.from('available_usernames').delete().eq('id', selectedPrize.id);
    }

    // Update cooldown
    await supabase.from('user_cooldowns').upsert({
      user_token: userToken,
      last_spun_at: new Date().toISOString()
    }, { onConflict: 'user_token' });

    // Record win
    await supabase.from('recent_winners').insert({
      prize: selectedPrize.value,
      prize_type: selectedPrize.prize_type
    });

    // Generate visual reel items using the pool names as fillers
    const reel = [];
    for (let i = 0; i < 30; i++) {
      if (i === 15) {
        reel.push(selectedPrize.value);
      } else {
        const randomFiller = combinedPool[Math.floor(Math.random() * combinedPool.length)];
        reel.push(randomFiller.value);
      }
    }

    let claimMessage = '';
    if (selectedPrize.prize_type === 'username') {
      claimMessage = `Claim your username at https://guns.lol/`;
    } else if (selectedPrize.prize_type === 'discord_access') {
      claimMessage = `Open a ticket with proof in discord.gg/vaultsociety to claim.`;
    } else {
      claimMessage = `Use your store voucher at checkout.`;
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