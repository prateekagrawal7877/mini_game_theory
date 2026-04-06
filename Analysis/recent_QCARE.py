import numpy as np
import pandas as pd
from scipy.stats import norm
from scipy.optimize import minimize, minimize_scalar
import matplotlib.pyplot as plt
import os

# =========================================================
# 0. STRUCTURAL MODEL (baseline - no recency)
# =========================================================

def estimate_structural_alpha(df):
    """Estimate alpha WITHOUT recency bias (baseline structural model)"""
    results = []
    df = df.sort_values(by=['participant_id', 'pull_round_index'])
    
    for participant_id, group in df.groupby('participant_id'):
        pulls = group['pull_arm_index'].values
        rewards = group['pull_reward'].values
        ab_group = group['ab_group'].iloc[0]
        T = len(pulls)
        
        # Pre-compute k(t) - cumulative counts (no decay)
        k = np.zeros((T, 2))
        sum_rewards = np.array([0.0, 0.0])
        k_current = np.array([0, 0])
        
        for t in range(T):
            k[t] = k_current.copy()
            k_current[pulls[t]] += 1
            sum_rewards[pulls[t]] += rewards[t]
        
        mean_reward = np.mean(rewards)
        
        def neg_log_likelihood(alpha):
            LL = 0.0
            epsilon = 1e-10
            
            for t in range(T):
                arm = pulls[t]
                other = 1 - arm
                
                if k[t, arm] > 0:
                    mu_arm = sum_rewards[arm] / k[t, arm]
                else:
                    mu_arm = 0.0
                
                if k[t, other] > 0:
                    mu_other = sum_rewards[other] / k[t, other]
                else:
                    mu_other = 0.0
                
                k_arm = k[t, arm]
                k_other = k[t, other]
                
                var_arm = 1.0 / ((k_arm + 1)**(2 * alpha))
                var_other = 1.0 / ((k_other + 1)**(2 * alpha))
                
                std = np.sqrt(var_arm + var_other)
                z = (mu_arm - mu_other) / std
                
                prob = norm.cdf(z)
                prob = np.clip(prob, epsilon, 1 - epsilon)
                LL += np.log(prob)
            
            return -LL
        
        res = minimize_scalar(neg_log_likelihood, bounds=(-10.0, 50.0), method='bounded')
        
        results.append({
            'participant_id': participant_id,
            'ab_group': ab_group,
            'alpha_structural': res.x,
            'mean_reward': mean_reward
        })
    
    return pd.DataFrame(results)

# =========================================================
# 1. RECENCY-BASED LIKELIHOOD ESTIMATION
# =========================================================

def estimate_real_data(df):
    results = []
    df = df.sort_values(by=['participant_id', 'pull_round_index'])
    
    for participant_id, group in df.groupby('participant_id'):
        pulls = group['pull_arm_index'].values
        rewards = group['pull_reward'].values
        ab_group = group['ab_group'].iloc[0]
        T = len(pulls)
        
        # Precompute k(t)
        k = np.zeros((T, 2))
        k_current = np.array([0, 0])
        for t in range(T):
            k[t] = k_current.copy()
            k_current[pulls[t]] += 1
        
        mean_reward = np.mean(rewards)
        
        def neg_log_likelihood(params):
            alpha, gamma = params
            
            if gamma <= 0 or gamma >= 1:
                return np.inf
            
            mu_rec = np.zeros(2)
            LL = 0.0
            eps = 1e-10
            
            for t in range(T):
                arm = pulls[t]
                other = 1 - arm
                
                mu_arm = mu_rec[arm]
                mu_other = mu_rec[other]
                
                k_arm = k[t, arm]
                k_other = k[t, other]
                
                var_arm = 1.0 / ((k_arm + 1)**(2 * alpha))
                var_other = 1.0 / ((k_other + 1)**(2 * alpha))
                
                std = np.sqrt(var_arm + var_other)
                z = (mu_arm - mu_other) / std
                
                prob = norm.cdf(z)
                prob = np.clip(prob, eps, 1 - eps)
                LL += np.log(prob)
                
                # update AFTER likelihood
                r = rewards[t]
                mu_rec[arm] = (1 - gamma) * mu_rec[arm] + gamma * r
            
            return -LL
        
        res = minimize(
            neg_log_likelihood,
            x0=[0.5, 0.2],
            bounds=[(-10.0, 50.0), (1e-3, 0.999)],
            method='L-BFGS-B'
        )
        
        results.append({
            'participant_id': participant_id,
            'ab_group': ab_group,
            'alpha': res.x[0],
            'gamma': res.x[1],
            'mean_reward': mean_reward
        })
    
    return pd.DataFrame(results)

# =========================================================
# STRUCTURAL MODEL ESTIMATION (without recency)
# =========================================================
def estimate_structural_alpha(df):
    """Estimate alpha using structural QCARE model (no recency bias)"""
    results = []
    df = df.sort_values(by=['participant_id', 'pull_round_index'])
    
    for participant_id, group in df.groupby('participant_id'):
        pulls = group['pull_arm_index'].values
        rewards = group['pull_reward'].values
        ab_group = group['ab_group'].iloc[0]
        
        T = len(pulls)
        k = np.zeros((T, 2))
        mu = np.zeros((T, 2))
        k_current = np.array([0, 0])
        sum_rewards = np.array([0.0, 0.0])
        
        for t in range(T):
            k[t] = k_current.copy()
            for i in range(2):
                if k_current[i] > 0: 
                    mu[t, i] = sum_rewards[i] / k_current[i]
                else: 
                    mu[t, i] = 0.0
            arm_pulled = pulls[t]
            k_current[arm_pulled] += 1
            sum_rewards[arm_pulled] += rewards[t]
            
        mean_reward = np.mean(rewards)
        
        def neg_log_likelihood(alpha):
            LL = 0.0
            epsilon = 1e-10
            for t in range(T):
                arm = pulls[t]
                other_arm = 1 - arm
                mu_arm = mu[t, arm]
                mu_other = mu[t, other_arm]
                k_arm = k[t, arm]
                k_other = k[t, other_arm]
                
                var_arm = 1.0 / ((k_arm + 1)**(2 * alpha))
                var_other = 1.0 / ((k_other + 1)**(2 * alpha))
                
                std_dev = np.sqrt(var_arm + var_other)
                z = (mu_arm - mu_other) / std_dev
                prob = norm.cdf(z)
                prob = np.clip(prob, epsilon, 1.0 - epsilon)
                LL += np.log(prob)
            return -LL
            
        res = minimize_scalar(neg_log_likelihood, bounds=(-1.0, 5.0), method='bounded')
        results.append({
            'participant_id': participant_id,
            'ab_group': ab_group,
            'alpha_structural': res.x if res.success else np.nan,
            'mean_reward': mean_reward
        })
    return pd.DataFrame(results)

# =========================================================
# STRUCTURAL CURVE SIMULATOR (for theoretical baseline)
# =========================================================
def simulate_qcare_structural_vectorized(T, alphas, mu_config, num_paths=2000):
    results = {}
    for alpha in alphas:
        k = np.zeros((num_paths, 2))
        sum_rewards = np.zeros((num_paths, 2))
        total_rewards = np.zeros(num_paths)
        for t in range(T):
            mu_hat = np.zeros((num_paths, 2))
            mask0 = k[:, 0] > 0
            mu_hat[mask0, 0] = sum_rewards[mask0, 0] / k[mask0, 0]
            mask1 = k[:, 1] > 0
            mu_hat[mask1, 1] = sum_rewards[mask1, 1] / k[mask1, 1]
            
            epsilon = np.random.normal(0, 1, size=(2, num_paths))
            beta_0 = 1.0 / ((k[:, 0] + 1) ** alpha)
            beta_1 = 1.0 / ((k[:, 1] + 1) ** alpha)
            
            theta_0 = mu_hat[:, 0] + epsilon[0] * beta_0
            theta_1 = mu_hat[:, 1] + epsilon[1] * beta_1
            
            arm = (theta_1 > theta_0).astype(int)
            
            reward = np.zeros(num_paths)
            reward[arm == 0] = np.random.binomial(1, mu_config[0], size=np.sum(arm == 0))
            reward[arm == 1] = np.random.binomial(1, mu_config[1], size=np.sum(arm == 1))
            
            k[np.arange(num_paths), arm] += 1
            sum_rewards[np.arange(num_paths), arm] += reward
            total_rewards += reward
            
        mean_rewards = total_rewards / T
        results[alpha] = {
            'mean': np.mean(mean_rewards),
            'p5': np.percentile(mean_rewards, 5),
            'p95': np.percentile(mean_rewards, 95)
        }
    return results

# =========================================================
# 2. SIMULATION WITH RECENCY BIAS
# =========================================================

def simulate_qcare_recency(T, alpha, gamma, mu_config, num_paths=2000):
    rewards_all = []
    
    for _ in range(num_paths):
        k = np.zeros(2)
        mu_rec = np.zeros(2)
        total_reward = 0
        
        for t in range(T):
            beta = 1.0 / ((k + 1)**alpha)
            epsilon = np.random.normal(0, 1, 2)
            theta = mu_rec + beta * epsilon
            
            arm = np.argmax(theta)
            
            reward = np.random.binomial(1, mu_config[arm])
            
            # update
            mu_rec[arm] = (1 - gamma) * mu_rec[arm] + gamma * reward
            k[arm] += 1
            total_reward += reward
        
        rewards_all.append(total_reward / T)
    
    return np.array(rewards_all)

# =========================================================
# 3. EXECUTION - COMPARATIVE ANALYSIS
# =========================================================

print("Loading data...")
script_dir = os.path.dirname(os.path.abspath(__file__))
csv_path = os.path.join(script_dir, "experiment_exp_1_pull_history (1).csv")
df = pd.read_csv(csv_path)

print("Estimating parameters (Recency-QCARE model)...")
res_df_recency = estimate_real_data(df)

print("Estimating parameters (Structural QCARE model - baseline)...")
res_df_structural = estimate_structural_alpha(df)

# Merge the two results
res_df_combined = res_df_recency.copy()
res_df_combined['alpha_structural'] = res_df_structural.set_index('participant_id').loc[res_df_combined['participant_id'], 'alpha_structural'].values

print("\nRecency-QCARE Results:")
print(res_df_recency.head())
print("\nStructural Model Alpha Estimates:")
print(res_df_structural.head())

# =========================================================
# 6. TRAIN/TEST SPLIT ANALYSIS (75% / 25%)
# =========================================================

print("\n" + "="*100)
print("TRAIN/TEST SPLIT ANALYSIS (75% Training / 25% Testing)")
print("="*100)

def compute_log_likelihood_structural(pulls, rewards, alpha, ab_group):
    """Compute log likelihood for structural model"""
    T = len(pulls)
    k = np.zeros((T, 2))
    sum_rewards = np.array([0.0, 0.0])
    k_current = np.array([0, 0])
    
    for t in range(T):
        k[t] = k_current.copy()
        k_current[pulls[t]] += 1
        sum_rewards[pulls[t]] += rewards[t]
    
    LL = 0.0
    epsilon = 1e-10
    
    for t in range(T):
        arm = pulls[t]
        other = 1 - arm
        
        if k[t, arm] > 0:
            mu_arm = sum_rewards[arm] / k[t, arm]
        else:
            mu_arm = 0.0
        
        if k[t, other] > 0:
            mu_other = sum_rewards[other] / k[t, other]
        else:
            mu_other = 0.0
        
        k_arm = k[t, arm]
        k_other = k[t, other]
        
        var_arm = 1.0 / ((k_arm + 1)**(2 * alpha))
        var_other = 1.0 / ((k_other + 1)**(2 * alpha))
        
        std = np.sqrt(var_arm + var_other)
        z = (mu_arm - mu_other) / std
        
        prob = norm.cdf(z)
        prob = np.clip(prob, epsilon, 1 - epsilon)
        LL += np.log(prob)
    
    return LL

def compute_log_likelihood_recency(pulls, rewards, alpha, gamma, ab_group):
    """Compute log likelihood for recency model"""
    T = len(pulls)
    k = np.zeros((T, 2))
    k_current = np.array([0, 0])
    
    for t in range(T):
        k[t] = k_current.copy()
        k_current[pulls[t]] += 1
    
    LL = 0.0
    epsilon = 1e-10
    mu_rec = np.zeros(2)
    
    for t in range(T):
        arm = pulls[t]
        other = 1 - arm
        
        mu_arm = mu_rec[arm]
        mu_other = mu_rec[other]
        
        k_arm = k[t, arm]
        k_other = k[t, other]
        
        var_arm = 1.0 / ((k_arm + 1)**(2 * alpha))
        var_other = 1.0 / ((k_other + 1)**(2 * alpha))
        
        std = np.sqrt(var_arm + var_other)
        z = (mu_arm - mu_other) / std
        
        prob = norm.cdf(z)
        prob = np.clip(prob, epsilon, 1 - epsilon)
        LL += np.log(prob)
        
        # update
        r = rewards[t]
        mu_rec[arm] = (1 - gamma) * mu_rec[arm] + gamma * r
    
    return LL

# Analyze each unique experiment
experiments = df['participant_id'].unique()
train_test_results = []

for participant_id in experiments:
    participant_data = df[df['participant_id'] == participant_id].sort_values('pull_round_index')
    
    n_rounds = len(participant_data)
    split_idx = int(n_rounds * 0.75)
    
    train_data = participant_data.iloc[:split_idx]
    test_data = participant_data.iloc[split_idx:]
    
    train_pulls = train_data['pull_arm_index'].values
    train_rewards = train_data['pull_reward'].values
    test_pulls = test_data['pull_arm_index'].values
    test_rewards = test_data['pull_reward'].values
    ab_group = participant_data['ab_group'].iloc[0]
    
    # Get estimated parameters
    alpha_struct = res_df_structural[res_df_structural['participant_id'] == participant_id]['alpha_structural'].values[0]
    alpha_rec = res_df_recency[res_df_recency['participant_id'] == participant_id]['alpha'].values[0]
    gamma_rec = res_df_recency[res_df_recency['participant_id'] == participant_id]['gamma'].values[0]
    
    # Compute log likelihoods
    struct_train_ll = compute_log_likelihood_structural(train_pulls, train_rewards, alpha_struct, ab_group)
    struct_test_ll = compute_log_likelihood_structural(test_pulls, test_rewards, alpha_struct, ab_group)
    
    rec_train_ll = compute_log_likelihood_recency(train_pulls, train_rewards, alpha_rec, gamma_rec, ab_group)
    rec_test_ll = compute_log_likelihood_recency(test_pulls, test_rewards, alpha_rec, gamma_rec, ab_group)
    
    train_test_results.append({
        'participant_id': participant_id,
        'ab_group': ab_group,
        'n_train_rounds': len(train_data),
        'n_test_rounds': len(test_data),
        'struct_train_ll': struct_train_ll,
        'struct_test_ll': struct_test_ll,
        'recency_train_ll': rec_train_ll,
        'recency_test_ll': rec_test_ll,
        'struct_train_ll_per_round': struct_train_ll / len(train_data),
        'struct_test_ll_per_round': struct_test_ll / len(test_data),
        'recency_train_ll_per_round': rec_train_ll / len(train_data),
        'recency_test_ll_per_round': rec_test_ll / len(test_data)
    })

train_test_df = pd.DataFrame(train_test_results)

print("\nDetailed Train/Test Results per Participant:")
print(train_test_df.to_string(index=False))

# Summary statistics
print("\n" + "="*100)
print("SUMMARY STATISTICS - Train/Test Log Likelihood")
print("="*100)

summary = pd.DataFrame({
    'Metric': [
        'Structural Model - Train LL (mean)',
        'Structural Model - Test LL (mean)',
        'Structural Model - Train LL/round (mean)',
        'Structural Model - Test LL/round (mean)',
        'Recency Model - Train LL (mean)',
        'Recency Model - Test LL (mean)',
        'Recency Model - Train LL/round (mean)',
        'Recency Model - Test LL/round (mean)',
        'LL Improvement (Recency vs Structural) - Test Set'
    ],
    'Overall': [
        train_test_df['struct_train_ll'].mean(),
        train_test_df['struct_test_ll'].mean(),
        train_test_df['struct_train_ll_per_round'].mean(),
        train_test_df['struct_test_ll_per_round'].mean(),
        train_test_df['recency_train_ll'].mean(),
        train_test_df['recency_test_ll'].mean(),
        train_test_df['recency_train_ll_per_round'].mean(),
        train_test_df['recency_test_ll_per_round'].mean(),
        (train_test_df['recency_test_ll'] - train_test_df['struct_test_ll']).mean()
    ]
})

for grp in sorted(train_test_df['ab_group'].unique()):
    grp_subset = train_test_df[train_test_df['ab_group'] == grp]
    summary[f'Group {grp}'] = [
        grp_subset['struct_train_ll'].mean(),
        grp_subset['struct_test_ll'].mean(),
        grp_subset['struct_train_ll_per_round'].mean(),
        grp_subset['struct_test_ll_per_round'].mean(),
        grp_subset['recency_train_ll'].mean(),
        grp_subset['recency_test_ll'].mean(),
        grp_subset['recency_train_ll_per_round'].mean(),
        grp_subset['recency_test_ll_per_round'].mean(),
        (grp_subset['recency_test_ll'] - grp_subset['struct_test_ll']).mean()
    ]

print(summary.to_string(index=False))

# Check for overfitting
print("\n" + "="*100)
print("OVERFITTING ANALYSIS")
print("="*100)

train_test_df['struct_overfitting'] = train_test_df['struct_train_ll_per_round'] - train_test_df['struct_test_ll_per_round']
train_test_df['recency_overfitting'] = train_test_df['recency_train_ll_per_round'] - train_test_df['recency_test_ll_per_round']

overfitting_summary = pd.DataFrame({
    'Model': ['Structural', 'Recency'],
    'Mean Train-Test Gap (per round)': [
        train_test_df['struct_overfitting'].mean(),
        train_test_df['recency_overfitting'].mean()
    ],
    'Max Train-Test Gap': [
        train_test_df['struct_overfitting'].max(),
        train_test_df['recency_overfitting'].max()
    ],
    'Min Train-Test Gap': [
        train_test_df['struct_overfitting'].min(),
        train_test_df['recency_overfitting'].min()
    ]
})

print(overfitting_summary.to_string(index=False))
print("\nNote: Positive gap = overfitting (train LL > test LL)")
print("="*100)

# =========================================================
# 5. VISUALIZATION WITH COMPARATIVE ANALYSIS
# =========================================================

# Color map for groups
colors = {'A': 'darkgreen', 'B': 'orange'}

# Plot 1: Alpha Shift with Arrows (Structural → Recency)
fig, ax = plt.subplots(figsize=(14, 8))

for grp in res_df_combined['ab_group'].unique():
    subset = res_df_combined[res_df_combined['ab_group'] == grp]
    
    # Plot structural alpha (starting point)
    ax.scatter(subset['alpha_structural'], subset['mean_reward'], 
              color=colors.get(grp, 'gray'), s=100, marker='o', 
              label=f'Structural Alpha (Group {grp})', alpha=0.7, edgecolors='black', linewidth=0.5)
    
    # Plot recency alpha (ending point) with different marker
    ax.scatter(subset['alpha'], subset['mean_reward'], 
              color=colors.get(grp, 'gray'), s=100, marker='s', 
              label=f'Recency Alpha (Group {grp})', alpha=0.7, edgecolors='black', linewidth=0.5)
    
    # Draw arrows from structural to recency
    for idx, row in subset.iterrows():
        ax.annotate('', xy=(row['alpha'], row['mean_reward']), 
                   xytext=(row['alpha_structural'], row['mean_reward']),
                   arrowprops=dict(arrowstyle='->', lw=1.5, color=colors.get(grp, 'gray'), alpha=0.5))

ax.set_xlabel('Alpha (Exploration Decay Parameter)', fontsize=12, fontweight='bold')
ax.set_ylabel('Mean Reward', fontsize=12, fontweight='bold')
ax.set_title('QCARE Model Comparison: How Alpha Shifts with Recency Bias\n(Circles=Structural, Squares=Recency with Gamma)', 
            fontsize=14, fontweight='bold')
ax.grid(True, linestyle='--', alpha=0.5)
ax.legend(loc='best', fontsize=10)
plt.tight_layout()
plt.savefig(os.path.join(script_dir, 'alpha_shift_comparison.png'), dpi=300, bbox_inches='tight')
print("Saved: alpha_shift_comparison.png")
plt.close()

# Plot 2: 2D Scatter - Alpha vs Gamma (Recency Model)
fig, ax = plt.subplots(figsize=(12, 8))

for grp in res_df_combined['ab_group'].unique():
    subset = res_df_combined[res_df_combined['ab_group'] == grp]
    scatter = ax.scatter(subset['alpha'], subset['gamma'], 
                        c=subset['mean_reward'], cmap='viridis', s=150,
                        label=f'Group {grp}', alpha=0.8, edgecolors='black', linewidth=0.5)

cbar = plt.colorbar(scatter, ax=ax)
cbar.set_label('Mean Reward', fontsize=11, fontweight='bold')
ax.set_xlabel('Alpha (Exploration Decay)', fontsize=12, fontweight='bold')
ax.set_ylabel('Gamma (Recency Bias)', fontsize=12, fontweight='bold')
ax.set_title('Recency-QCARE Model: Alpha vs Gamma Parameter Space\n(Color = Mean Reward Performance)', 
            fontsize=14, fontweight='bold')
ax.grid(True, linestyle='--', alpha=0.5)
ax.legend(loc='best', fontsize=10)
plt.tight_layout()
plt.savefig(os.path.join(script_dir, 'alpha_gamma_space.png'), dpi=300, bbox_inches='tight')
print("Saved: alpha_gamma_space.png")
plt.close()

# Plot 3: Detailed Shift Analysis with Gamma Size
fig, ax = plt.subplots(figsize=(14, 9))

for grp in res_df_combined['ab_group'].unique():
    subset = res_df_combined[res_df_combined['ab_group'] == grp]
    
    # Normalize gamma for marker size (scaled between 50 and 500)
    sizes_structural = 100
    sizes_recency = 100 + (subset['gamma'] * 400)
    
    # Structural points (circles)
    ax.scatter(subset['alpha_structural'], subset['mean_reward'], 
              s=sizes_structural, color=colors.get(grp, 'gray'), 
              marker='o', alpha=0.6, label=f'Structural (Group {grp})',
              edgecolors='black', linewidth=1)
    
    # Recency points (squares, size = gamma)
    ax.scatter(subset['alpha'], subset['mean_reward'], 
              s=sizes_recency, color=colors.get(grp, 'gray'), 
              marker='s', alpha=0.6, label=f'Recency w/ Gamma (Group {grp})',
              edgecolors='black', linewidth=1)
    
    # Arrows showing shift
    for idx, row in subset.iterrows():
        ax.annotate('', xy=(row['alpha'], row['mean_reward']), 
                   xytext=(row['alpha_structural'], row['mean_reward']),
                   arrowprops=dict(arrowstyle='->', lw=1.5, color=colors.get(grp, 'gray'), alpha=0.4))

ax.set_xlabel('Alpha (Exploration Decay Parameter)', fontsize=12, fontweight='bold')
ax.set_ylabel('Mean Reward', fontsize=12, fontweight='bold')
ax.set_title('Detailed Alpha Shift Analysis: Including Gamma Effect\n(Marker Size ∝ Gamma | Circles=Structural | Squares=Recency)', 
            fontsize=14, fontweight='bold')
ax.grid(True, linestyle='--', alpha=0.5)
ax.legend(loc='best', fontsize=10)
plt.tight_layout()
plt.savefig(os.path.join(script_dir, 'detailed_shift_with_gamma.png'), dpi=300, bbox_inches='tight')
print("Saved: detailed_shift_with_gamma.png")
plt.close()

# Plot 4: Distribution of Alpha Changes
fig, ax = plt.subplots(figsize=(12, 7))

alpha_shifts = res_df_combined['alpha'] - res_df_combined['alpha_structural']

for grp in res_df_combined['ab_group'].unique():
    subset_shifts = alpha_shifts[res_df_combined['ab_group'] == grp]
    ax.hist(subset_shifts, bins=15, alpha=0.6, label=f'Group {grp}',
           color=colors.get(grp, 'gray'), edgecolor='black')

ax.axvline(x=0, color='red', linestyle='--', linewidth=2, label='No Change')
ax.axvline(x=alpha_shifts.mean(), color='purple', linestyle='-', linewidth=2, 
          label=f'Mean Shift: {alpha_shifts.mean():.3f}')
ax.set_xlabel('Alpha Change (Recency - Structural)', fontsize=12, fontweight='bold')
ax.set_ylabel('Frequency', fontsize=12, fontweight='bold')
ax.set_title('Distribution of Alpha Parameter Shifts\n(How Much Do Individual Alphas Change?)', 
            fontsize=14, fontweight='bold')
ax.legend(loc='best', fontsize=10)
ax.grid(True, alpha=0.3, axis='y')
plt.tight_layout()
plt.savefig(os.path.join(script_dir, 'alpha_shift_distribution.png'), dpi=300, bbox_inches='tight')
print("Saved: alpha_shift_distribution.png")
plt.close()

# Plot 5: Summary Statistics Table
print("\n" + "="*80)
print("COMPARATIVE ANALYSIS SUMMARY")
print("="*80)

summary_stats = pd.DataFrame({
    'Metric': [
        'Mean Alpha (Structural)',
        'Mean Alpha (Recency)',
        'Mean Alpha Shift',
        'Mean Gamma',
        'Mean Reward'
    ],
    'Overall': [
        res_df_combined['alpha_structural'].mean(),
        res_df_combined['alpha'].mean(),
        (res_df_combined['alpha'] - res_df_combined['alpha_structural']).mean(),
        res_df_combined['gamma'].mean(),
        res_df_combined['mean_reward'].mean()
    ]
})

for grp in sorted(res_df_combined['ab_group'].unique()):
    subset = res_df_combined[res_df_combined['ab_group'] == grp]
    summary_stats[f'Group {grp}'] = [
        subset['alpha_structural'].mean(),
        subset['alpha'].mean(),
        (subset['alpha'] - subset['alpha_structural']).mean(),
        subset['gamma'].mean(),
        subset['mean_reward'].mean()
    ]

print(summary_stats.to_string(index=False))
print("="*80)

grid_alphas = np.linspace(-0.5, 2.0, 30)
colors = {'A': 'darkgreen', 'B': 'orange'}

# --- Experiment 1: Structural Curve + Both Alpha Estimates ---
print("\nSimulating theoretical curves for Exp 1 (Structural model with mu = 0.6, 0.4)...")
curve_res1 = simulate_qcare_structural_vectorized(100, grid_alphas, (0.6, 0.4), 2000)
mean_curve1 = [curve_res1[a]['mean'] for a in grid_alphas]
p5_curve1 = [curve_res1[a]['p5'] for a in grid_alphas]
p95_curve1 = [curve_res1[a]['p95'] for a in grid_alphas]
opt_alpha1 = grid_alphas[np.argmax(mean_curve1)]

fig, ax = plt.subplots(figsize=(12, 7))

# Plot theoretical curves
ax.plot(grid_alphas, mean_curve1, color='purple', label='Theoretical Curve (Structural)', linewidth=2.5)
ax.plot(grid_alphas, p5_curve1, '--', color='blue', alpha=0.4, label='5th/95th Percentile')
ax.plot(grid_alphas, p95_curve1, '--', color='blue', alpha=0.4)
ax.fill_between(grid_alphas, p5_curve1, p95_curve1, color='blue', alpha=0.1)
ax.axvline(x=opt_alpha1, color='blue', linestyle='-', linewidth=2.5, label=f'Optimal Alpha (Structural) = {opt_alpha1:.2f}')

# Scatter structural model: alpha_structural vs mean_reward
for grp in res_df_combined['ab_group'].unique():
    sub = res_df_combined[res_df_combined['ab_group'] == grp]
    ax.scatter(sub['alpha_structural'], sub['mean_reward'], 
              color=colors.get(grp, 'red'), s=100, alpha=0.6, 
              marker='o', label=f'Structural Estimate (Group {grp})', edgecolors='black', linewidth=1.5)

# Scatter recency model: alpha vs mean_reward  
for grp in res_df_combined['ab_group'].unique():
    sub = res_df_combined[res_df_combined['ab_group'] == grp]
    ax.scatter(sub['alpha'], sub['mean_reward'], 
              color=colors.get(grp, 'red'), s=100, alpha=0.6, 
              marker='s', label=f'Recency-QCARE Estimate (Group {grp})', edgecolors='black', linewidth=1.5)

# Draw arrows showing shift from structural to recency
for idx, row in res_df_combined.iterrows():
    ax.annotate('', xy=(row['alpha'], row['mean_reward']), 
               xytext=(row['alpha_structural'], row['mean_reward']),
               arrowprops=dict(arrowstyle='->', lw=1.5, alpha=0.4, color='red'))

ax.set_title('Experiment 1: Alpha Shift from Structural → Recency-QCARE Model\n(μ₀=0.6, μ₁=0.4)', 
            fontsize=14, fontweight='bold')
ax.set_xlabel('Estimated Alpha', fontsize=12)
ax.set_ylabel('Mean Reward', fontsize=12)
ax.legend(loc='lower right', fontsize=10)
ax.grid(True, linestyle='--', alpha=0.5)
fig.tight_layout()
fig.savefig(os.path.join(script_dir, 'exp1_recency_vs_structural.png'), dpi=300, bbox_inches='tight')
print(f"Saved: exp1_recency_vs_structural.png")
plt.close()

# Additional analysis output
print("\n" + "="*70)
print("COMPARATIVE ANALYSIS SUMMARY")
print("="*70)
print(f"\nStructural Model:")
print(f"  Mean Alpha: {res_df_structural['alpha_structural'].mean():.4f}")
print(f"  Std Alpha:  {res_df_structural['alpha_structural'].std():.4f}")

print(f"\nRecency-QCARE Model:")
print(f"  Mean Alpha: {res_df_recency['alpha'].mean():.4f}")
print(f"  Std Alpha:  {res_df_recency['alpha'].std():.4f}")
print(f"  Mean Gamma: {res_df_recency['gamma'].mean():.4f}")
print(f"  Std Gamma:  {res_df_recency['gamma'].std():.4f}")

alpha_shift = res_df_recency['alpha'].mean() - res_df_structural['alpha_structural'].mean()
print(f"\nMean Alpha Shift (Recency - Structural): {alpha_shift:.4f}")
print("="*70)